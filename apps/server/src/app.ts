import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { SESSION_COOKIE, userFromToken } from './core/auth.ts';
import { HttpError } from './lib/errors.ts';
import { logger } from './lib/logger.ts';
import accountRoutes from './modules/accounts/routes.ts';
import aiRoutes from './modules/ai/routes.ts';
import auditRoutes from './modules/audit/routes.ts';
import microsoftRoutes from './modules/auth/microsoft.ts';
import authRoutes from './modules/auth/routes.ts';
import messageRoutes from './modules/conversations/messages.ts';
import conversationRoutes from './modules/conversations/routes.ts';
import fileRoutes from './modules/files/routes.ts';
import labelRoutes from './modules/labels/routes.ts';
import liveRoutes from './modules/live/routes.ts';
import networkRoutes from './modules/network/routes.ts';
import pushRoutes from './modules/push/routes.ts';
import systemRoutes from './modules/system/routes.ts';
import templateRoutes from './modules/templates/routes.ts';
import userRoutes from './modules/users/routes.ts';
import webhookRoutes from './modules/webhooks/routes.ts';

const MODULES = [
  systemRoutes,
  authRoutes,
  microsoftRoutes,
  userRoutes,
  accountRoutes,
  conversationRoutes,
  messageRoutes,
  labelRoutes,
  templateRoutes,
  fileRoutes,
  networkRoutes,
  liveRoutes,
  auditRoutes,
  webhookRoutes,
  pushRoutes,
  aiRoutes,
];

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger, trustProxy: true, bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart);

  // Accept empty JSON bodies (e.g. DELETE/POST without payload) as {}.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (e) {
      done(Object.assign(e as Error, { statusCode: 400 }), undefined);
    }
  });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    // Reject cross-site state-changing requests (session cookies are also SameSite=Lax).
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin) {
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      if (new URL(req.headers.origin).host !== host) throw new HttpError(403, 'Cross-site request blocked');
    }
    req.user = await userFromToken(req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: err.issues.map((i) => i.message).join(', ') });
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (err as Error).message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Something went wrong' });
  });

  for (const mod of MODULES) await app.register(mod);
  return app;
}
