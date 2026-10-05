import type { Server as HttpServer } from 'node:http';
import {
  ADMINS_ROOM,
  accountRoom,
  type ClientToServerEvents,
  EVERYONE_ROOM,
  REALTIME_CHANNEL,
  type ServerToClientEvents,
  userRoom,
} from '@linkunify/contracts';
import { Server } from 'socket.io';
import { logger } from '../lib/logger.ts';
import { newRedis } from '../lib/redis.ts';
import { accessibleAccountIds, conversationForUser } from './access.ts';
import { parseCookies, SESSION_COOKIE, type SessionUser, userFromToken } from './auth.ts';

type SocketData = { user: SessionUser };

/** Socket.IO server: rooms per account/user; events published to Redis are relayed here. */
export function startRealtime(server: HttpServer) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(server, {
    path: '/socket.io',
    serveClient: false,
    cors: { origin: false },
  });

  io.use(async (socket, next) => {
    const user = await userFromToken(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]).catch(() => null);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', async (socket) => {
    const user = socket.data.user;
    socket.join([userRoom(user.id), EVERYONE_ROOM]);
    if (user.role !== 'MEMBER') socket.join(ADMINS_ROOM);
    for (const id of await accessibleAccountIds(user)) socket.join(accountRoom(id));

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
