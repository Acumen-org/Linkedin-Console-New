import type { Server as HttpServer } from 'node:http';
import {
  ADMINS_ROOM,
  accountRoom,
  type ClientToServerEvents,
  EVERYONE_ROOM,
  isAdminRole,
  REALTIME_CHANNEL,
  type ServerToClientEvents,
  userRoom,
} from '@linkedin-console/contracts';
import { Server } from 'socket.io';
import { logger } from '../lib/logger.ts';
import { newRedis } from '../lib/redis.ts';
import { accessibleAccountIds, conversationForUser } from './access.ts';
import { parseCookies, SESSION_COOKIE, type SessionUser, userFromToken } from './auth.ts';

type SocketData = { user: SessionUser; token: string; accountIds: string[] };

/** Open sockets re-check their session this often (revoked, expired or disabled → disconnected). */
const SESSION_RECHECK_MS = 5 * 60_000;

/** Socket.IO server: rooms per account/user; events published to Redis are relayed here. */
export function startRealtime(server: HttpServer) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(server, {
    path: '/socket.io',
    serveClient: false,
    cors: { origin: false },
  });

  // Everything that can fail (database) happens here, where an error refuses the connection instead of
  // becoming an unhandled rejection that would take the whole API down.
  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE] ?? '';
      const user = await userFromToken(token);
      if (!user) return next(new Error('unauthorized'));
      socket.data = { user, token, accountIds: await accessibleAccountIds(user) };
      next();
    } catch (err) {
      logger.warn({ err }, 'socket auth failed');
      next(new Error('unavailable'));
    }
  });

  io.on('connection', (socket) => {
    const { user, token, accountIds } = socket.data;
    socket.join([userRoom(user.id), EVERYONE_ROOM]);
    if (isAdminRole(user.role)) socket.join(ADMINS_ROOM);
    for (const id of accountIds) socket.join(accountRoom(id));

    const recheck = setInterval(async () => {
      const still = await userFromToken(token).catch(() => user); // a database blip is no reason to disconnect
      if (!still) socket.disconnect(true);
    }, SESSION_RECHECK_MS);
    socket.on('disconnect', () => clearInterval(recheck));

    // Team presence: "Ali is replying…" (our users, not LinkedIn's typing indicator).
    socket.on('composing', async ({ conversationId, active }) => {
      try {
        const { conversation } = await conversationForUser(user, String(conversationId), 'READ');
        socket
          .to(accountRoom(conversation.accountId))
          .emit('team.composing', { conversationId, userId: user.id, name: user.name, active: !!active });
      } catch {}
    });
  });

  const sub = newRedis();
  sub.subscribe(REALTIME_CHANNEL);
  sub.on('message', (_channel, raw) => {
    try {
      const { rooms, event, data } = JSON.parse(raw) as { rooms: string[]; event: keyof ServerToClientEvents; data: never };
      io.to(rooms).emit(event, data);
      // Permissions changed: clients reconnect and join the right rooms.
      if (event === 'grants.changed') for (const r of rooms) io.in(r).disconnectSockets();
    } catch (err) {
      logger.warn({ err }, 'bad realtime message');
    }
  });

  return io;
}
