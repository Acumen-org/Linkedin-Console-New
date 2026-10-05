import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { config } from './config.ts';
import { migrate, sql } from './db.ts';
import { COOKIE, HttpError, userFromToken } from './auth.ts';
import { startRealtime } from './realtime.ts';
import authRoutes from './routes/auth.ts';
import userRoutes from './routes/users.ts';
import accountRoutes from './routes/accounts.ts';
import conversationRoutes from './routes/conversations.ts';
import fileRoutes from './routes/files.ts';
import miscRoutes from './routes/misc.ts';

await migrate();

const app = Fastify({ logger: { level: 'info' }, trustProxy: true, bodyLimit: 1024 * 1024 });
await app.register(cookie);
await app.register(multipart);

// Accept empty JSON bodies (e.g. DELETE/POST without payload) as {}.
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  try { done(null, body ? JSON.parse(body as string) : {}); } catch (e) { done(Object.assign(e as Error, { statusCode: 400 }), undefined); }
});

app.decorateRequest('user', null);
app.addHook('onRequest', async (req) => {
  // Reject cross-site state-changing requests (cookies are SameSite=Lax as well).
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    if (new URL(req.headers.origin).host !== host) throw new HttpError(403, 'Cross-site request blocked');
  }
  req.user = await userFromToken(req.cookies[COOKIE]);
});

app.setErrorHandler((err, req, reply) => {
  if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => i.message).join(', ') });
  if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
  const status = (err as { statusCode?: number }).statusCode;
  if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
  req.log.error(err);
  return reply.code(500).send({ error: 'Something went wrong' });
});

app.get('/api/health', async () => {
  await sql`SELECT 1`;
  return { ok: true };
});

await app.register(authRoutes);
await app.register(userRoutes);
await app.register(accountRoutes);
await app.register(conversationRoutes);
await app.register(fileRoutes);
await app.register(miscRoutes);

startRealtime(app.server);
await app.listen({ port: config.port, host: '0.0.0.0' });
