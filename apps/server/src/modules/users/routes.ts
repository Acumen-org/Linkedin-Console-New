import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { hashPassword, requireAdmin, requireUser } from '../../core/auth.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { publish } from '../../lib/redis.ts';

export default async function userRoutes(app: FastifyInstance) {
  // Everyone can see the team list (for "sent by", assignment, presence).
  app.get('/api/users', async (req) => {
    const me = requireUser(req);
    const rows = await sql`SELECT id, name, email, role, disabled_at, created_at FROM users ORDER BY created_at`;
    return me.role === 'MEMBER' ? rows.map(({ email, ...r }) => r) : rows;
  });

  app.post('/api/users', async (req) => {
    const admin = requireAdmin(req);
    const body = z
      .object({
        name: z.string().min(1).max(100),
        email: z.email(),
        password: z.string().min(10).max(200),
        role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
      })
      .parse(req.body);
    const id = newId('usr');
    const [exists] = await sql`SELECT 1 FROM users WHERE email = ${body.email.toLowerCase()}`;
    if (exists) throw new HttpError(409, 'A user with this email already exists');
    await sql.begin(async (tx) => {
      await tx`INSERT INTO users (id, email, name, password_hash, role) VALUES (${id}, ${body.email.toLowerCase()}, ${body.name}, ${await hashPassword(body.password)}, ${body.role})`;
      // New teammates get the default grant on every existing LinkedIn account.
      await tx`INSERT INTO account_grants (account_id, user_id, level) SELECT id, ${id}, ${config.defaultGrant} FROM accounts`;
    });
    await audit({ userId: admin.id, action: 'user.created', meta: { targetUserId: id, email: body.email, role: body.role }, ip: req.ip });
    return { id };
  });

  app.patch('/api/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = z
      .object({
        name: z.string().min(1).max(100).optional(),
        role: z.enum(['ADMIN', 'MEMBER']).optional(),
        disabled: z.boolean().optional(),
        password: z.string().min(10).max(200).optional(),
      })
      .parse(req.body);
    const [target] = await sql`SELECT id, role FROM users WHERE id = ${id}`;
    if (!target) throw new HttpError(404, 'User not found');
    if (target.role === 'OWNER' && (body.role || body.disabled)) throw new HttpError(400, 'The owner cannot be demoted or disabled');
    if (target.role === 'OWNER' && admin.role !== 'OWNER') throw new HttpError(403, 'Only the owner can change the owner');

    if (body.name) await sql`UPDATE users SET name = ${body.name} WHERE id = ${id}`;
    if (body.role) await sql`UPDATE users SET role = ${body.role} WHERE id = ${id}`;
    if (body.password) {
      await sql`UPDATE users SET password_hash = ${await hashPassword(body.password)} WHERE id = ${id}`;
      await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    }
    if (body.disabled !== undefined) {
      await sql`UPDATE users SET disabled_at = ${body.disabled ? sql`now()` : null} WHERE id = ${id}`;
      if (body.disabled) await sql`DELETE FROM sessions WHERE user_id = ${id}`;
    }
    if (body.role || body.disabled) await publish(`user:${id}`, 'grants.changed', {});
    await audit({
      userId: admin.id,
      action: 'user.updated',
      meta: { targetUserId: id, ...body, password: body.password ? '***' : undefined },
      ip: req.ip,
    });
    return { ok: true };
  });
}
