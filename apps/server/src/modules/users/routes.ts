import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { hashPassword, requireAdmin, requireUser } from '../../core/auth.ts';
import { lastStaffSync, runStaffSync } from '../../core/staff-sync.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { publish } from '../../lib/redis.ts';

export default async function userRoutes(app: FastifyInstance) {
  // Everyone can see the team list (for "sent by", assignment, presence).
  app.get('/api/users', async (req) => {
    const me = requireUser(req);
    const rows = await sql`
      SELECT u.id, u.name, u.email, u.role, u.disabled_at, u.disabled_reason, u.created_at, u.source,
             u.password_hash IS NOT NULL AS has_password, u.microsoft_oid IS NOT NULL AS microsoft_linked,
             (SELECT max(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_sign_in_at
      FROM users u ORDER BY u.created_at`;
    // Members see names only (for assignment and "sent by"); admins see the security details.
    return me.role === 'MEMBER' ? rows.map(({ id, name, role, disabledAt }) => ({ id, name, role, disabledAt })) : rows;
  });

  /** How sign-in and the Twilio staff sync are set up, and the last sync result. */
  app.get('/api/users/directory', async (req) => {
    requireAdmin(req);
    return {
      microsoft: !!config.microsoft,
      passwordSignin: config.passwordSignin,
      staffSync: { mode: config.staffSync.mode, source: config.staffSync.url || null, last: await lastStaffSync() },
    };
  });

  app.post('/api/users/directory/sync', async (req) => {
    const admin = requireAdmin(req);
    if (config.staffSync.mode === 'off') throw new HttpError(409, 'Staff sync is not configured');
    const result = await runStaffSync();
    await audit({ userId: admin.id, action: 'user.sync_run', meta: { ...result }, ip: req.ip, req });
    return result;
  });

  app.post('/api/users', async (req) => {
    const admin = requireAdmin(req);
    const body = z
      .object({
        name: z.string().min(1).max(100),
        email: z.email(),
        // Optional with Microsoft sign-in: without one the teammate signs in with Microsoft only.
        password: config.microsoft ? z.string().min(10).max(200).optional() : z.string().min(10).max(200),
        role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
      })
      .parse(req.body);
    const id = newId('usr');
    const [exists] = await sql`SELECT 1 FROM users WHERE email = ${body.email.toLowerCase()}`;
    if (exists) throw new HttpError(409, 'A user with this email already exists');
    await sql.begin(async (tx) => {
      await tx`INSERT INTO users (id, email, name, password_hash, role) VALUES (${id}, ${body.email.toLowerCase()}, ${body.name}, ${body.password ? await hashPassword(body.password) : null}, ${body.role})`;
      // New teammates get the default grant on every existing LinkedIn account (none when DEFAULT_GRANT=NONE).
      if (config.defaultGrant !== 'NONE') {
        await tx`INSERT INTO account_grants (account_id, user_id, level) SELECT id, ${id}, ${config.defaultGrant} FROM accounts`;
      }
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
      await sql`
        UPDATE users SET disabled_at = ${body.disabled ? sql`now()` : null},
          disabled_reason = ${body.disabled ? `Disabled by ${admin.name}` : null}, disabled_by = ${body.disabled ? 'admin' : null}
        WHERE id = ${id}`;
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
