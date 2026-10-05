import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.ts';
import { newId } from '../ids.ts';
import { audit } from '../audit.ts';
import { COOKIE, HttpError, createSession, destroySession, hashPassword, requireUser, throttleLogin, verifyPassword } from '../auth.ts';

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
    await audit({ userId: id, action: 'setup.owner_created', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/login', async (req, reply) => {
    throttleLogin(req.ip);
    const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const [u] = await sql`SELECT id, password_hash, disabled_at FROM users WHERE email = ${body.email.toLowerCase().trim()}`;
    if (!u || u.disabledAt || !(await verifyPassword(u.passwordHash, body.password))) throw new HttpError(401, 'Wrong email or password');
    await createSession(reply, req, u.id);
    await audit({ userId: u.id, action: 'auth.login', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await destroySession(reply, req.cookies[COOKIE]);
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({ user: requireUser(req) }));

  app.post('/api/me/password', async (req, reply) => {
    const user = requireUser(req);
    const body = z.object({ current: z.string(), next: Password }).parse(req.body);
    const [u] = await sql`SELECT password_hash FROM users WHERE id = ${user.id}`;
    if (!(await verifyPassword(u.passwordHash, body.current))) throw new HttpError(400, 'Current password is wrong');
    await sql`UPDATE users SET password_hash = ${await hashPassword(body.next)} WHERE id = ${user.id}`;
    await sql`DELETE FROM sessions WHERE user_id = ${user.id}`;
    await createSession(reply, req, user.id);
    await audit({ userId: user.id, action: 'auth.password_changed', ip: req.ip });
    return { ok: true };
  });
}
