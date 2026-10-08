import { userRoom } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import {
  assertLoginAllowed,
  clearLoginFailures,
  createSession,
  destroySession,
  hashPassword,
  recordLoginFailure,
  requireUser,
  SESSION_COOKIE,
  verifyPassword,
} from '../../core/auth.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { publish } from '../../lib/redis.ts';

const WRONG_CREDENTIALS = config.microsoft
  ? 'Wrong email or password. If your team uses Microsoft accounts, use "Sign in with Microsoft".'
  : 'Wrong email or password';

const Password = z.string().min(10, 'Password must be at least 10 characters').max(200);

export default async function authRoutes(app: FastifyInstance) {
  app.get('/api/setup', async () => {
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM users`;
    return { needsSetup: count === 0 };
  });

  // First run only: create the OWNER account.
  app.post('/api/setup', async (req, reply) => {
    const body = z.object({ name: z.string().min(1).max(100), email: z.email(), password: Password }).parse(req.body);
    const id = newId('usr');
    const created = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(1001)`;
      const [{ count }] = await tx`SELECT count(*)::int AS count FROM users`;
      if (count > 0) return false;
      await tx`INSERT INTO users (id, email, name, password_hash, role) VALUES (${id}, ${body.email.toLowerCase()}, ${body.name}, ${await hashPassword(body.password)}, 'OWNER')`;
      return true;
    });
    if (!created) throw new HttpError(409, 'Setup already done');
    await createSession(reply, req, id);
    await audit({ userId: id, action: 'setup.owner_created', ip: req.ip, req });
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    assertLoginAllowed(req.ip);
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const [u] = await sql`SELECT id, role, password_hash, disabled_at FROM users WHERE email = ${body.email.toLowerCase().trim()}`;
    // With company sign-in on, passwords can be limited to the owner (emergency access). Same answer as a
    // wrong password (no hint whether the email belongs to a teammate), and it counts as a failure.
    if (u && !u.disabledAt && config.microsoft && (!u.passwordHash || (config.passwordSignin === 'owner' && u.role !== 'OWNER'))) {
      recordLoginFailure(req.ip);
      await audit({
        userId: u.id,
        action: 'auth.login_failed',
        meta: { email: body.email.slice(0, 200), reason: 'password sign-in not allowed' },
        ip: req.ip,
        req,
      });
      throw new HttpError(401, WRONG_CREDENTIALS);
    }
    if (!u || u.disabledAt || !u.passwordHash || !(await verifyPassword(u.passwordHash, body.password))) {
      recordLoginFailure(req.ip);
      const reason = !u ? 'unknown email' : u.disabledAt ? 'account disabled' : !u.passwordHash ? 'no password set' : 'wrong password';
      await audit({
        userId: u?.id ?? null,
        action: 'auth.login_failed',
        meta: { email: body.email.slice(0, 200), reason },
        ip: req.ip,
        req,
      });
      throw new HttpError(401, WRONG_CREDENTIALS);
    }
    clearLoginFailures(req.ip);
    await createSession(reply, req, u.id);
    await audit({ userId: u.id, action: 'auth.login', ip: req.ip, req });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.user) await audit({ userId: req.user.id, action: 'auth.logout', ip: req.ip, req });
    await destroySession(reply, req.cookies[SESSION_COOKIE]);
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ user: requireUser(req) }));

  app.post('/api/me/password', async (req, reply) => {
    const user = requireUser(req);
    const body = z.object({ current: z.string(), next: Password }).parse(req.body);
    const [u] = await sql`SELECT password_hash FROM users WHERE id = ${user.id}`;
    if (!u.passwordHash) throw new HttpError(400, 'This account signs in with Microsoft and has no password');
    if (!(await verifyPassword(u.passwordHash, body.current))) throw new HttpError(400, 'Current password is wrong');
    await sql`UPDATE users SET password_hash = ${await hashPassword(body.next)} WHERE id = ${user.id}`;
    await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;
    await createSession(reply, req, user.id);
    await publish(userRoom(user.id), 'grants.changed', {}); // other devices' live connections are dropped
    await audit({ userId: user.id, action: 'auth.password_changed', ip: req.ip, req });
    return { ok: true };
  });
}
