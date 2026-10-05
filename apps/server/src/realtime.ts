import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { COOKIE, parseCookies, userFromToken, type User } from './auth.ts';
import { accessibleAccountIds, conversationForUser } from './access.ts';
import { newRedis } from './redis.ts';

export function startRealtime(server: HttpServer) {
  const io = new Server(server, { path: '/socket.io', serveClient: false, cors: { origin: false } });

  io.use(async (socket, next) => {
    const user = await userFromToken(parseCookies(socket.handshake.headers.cookie)[COOKIE]).catch(() => null);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', async (socket) => {
    const user = socket.data.user as User;
    socket.join(`user:${user.id}`);
    if (user.role !== 'MEMBER') socket.join('admins');
    for (const id of await accessibleAccountIds(user)) socket.join(`acc:${id}`);

    // Team presence: "Ali is replying…" (our users, not LinkedIn's typing indicator).
    socket.on('composing', async ({ conversationId, active }) => {
      try {
        const { conversation } = await conversationForUser(user, String(conversationId), 'READ');
        socket.to(`acc:${conversation.accountId}`).emit('team.composing', { conversationId, userId: user.id, name: user.name, active: !!active });
      } catch {}
    });
  });

  // Worker/api publish events to Redis; relay them to the right rooms.
  const sub = newRedis();
  sub.subscribe('lu:emit');
  sub.on('message', (_ch, raw) => {
    try {
      const { rooms, event, data } = JSON.parse(raw);
      io.to(rooms).emit(event, data);
      if (event === 'grants.changed') for (const r of rooms) io.in(r).disconnectSockets(); // clients reconnect with new rooms
    } catch {}
  });

  return io;
}
