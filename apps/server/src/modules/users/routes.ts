import { isAdminRole } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { hashPassword, requireAdmin, requireUser } from '../../core/auth.ts';
import { applyGrants, assertStaff } from '../../core/grants.ts';
import { transferOwnership } from '../../core/owner.ts';
import { setStaffLimits, staffLimits } from '../../core/send-limits.ts';
import { lastStaffSync, runStaffSync } from '../../core/staff-sync.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { publish } from '../../lib/redis.ts';

/** With PASSWORD_SIGNIN=owner, staff sign in with Microsoft 365 only: no passwords to hand out. */
const assertPasswordAllowed = (role: string) => {
  if (config.passwordSignin === 'owner' && role !== 'OWNER')
    throw new HttpError(400, 'Only the owner signs in with a password; everyone else uses Microsoft 365');
};

const Level = z.enum(['READ', 'REPLY', 'FULL']);

export default async function userRoutes(app: FastifyInstance) {
  // Everyone can see the team list (for "sent by", assignment, presence).
  app.get('/api/users', async (req) => {
    const me = requireUser(req);
    const rows = await sql`
      SELECT u.id, u.name, u.email, u.role, u.disabled_at, u.disabled_reason, u.created_at, u.source,
             u.password_hash IS NOT NULL AS has_password, u.microsoft_oid IS NOT NULL AS microsoft_linked,
             (SELECT count(*)::int FROM account_grants g WHERE g.user_id = u.id) AS account_count, u.daily_send_cap,
             (SELECT count(*)::int FROM audit_log l WHERE l.user_id = u.id AND l.action IN ('message.send', 'message.start_chat')
                AND l.created_at > now() - interval '24 hours') AS sent_24h,
             (SELECT max(l.created_at) FROM audit_log l WHERE l.user_id = u.id AND l.action = 'auth.login') AS last_sign_in_at
      FROM users u ORDER BY u.created_at`;
    // Members see names only (for assignment and "sent by"); admins see the security details.
    return isAdminRole(me.role) ? rows : rows.map(({ id, name, role, disabledAt }) => ({ id, name, role, disabledAt }));
  });

  /** How sign-in and the staff sync are set up, and the last sync result. */
  app.get('/api/users/directory', async (req) => {
    requireAdmin(req);
    return {
      microsoft: !!config.microsoft,
      passwordSignin: config.passwordSignin,
      staffSync: {
        mode: config.staffSync.mode,
        kind: config.staffSync.source,
        source: config.staffSync.source === 'twenty' ? (config.twenty?.url ?? null) : config.staffSync.url || null,
        last: await lastStaffSync(),
      },
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
        role: z.enum(['ADMIN', 'MEMBER', 'AUDITOR']).default('MEMBER'),
      })
      .parse(req.body);
    if (body.password) assertPasswordAllowed(body.role);
    const id = newId('usr');
    const [exists] = await sql`SELECT 1 FROM users WHERE email = ${body.email.toLowerCase()}`;
    if (exists) throw new HttpError(409, 'A user with this email already exists');
    await sql.begin(async (tx) => {
      await tx`INSERT INTO users (id, email, name, password_hash, role) VALUES (${id}, ${body.email.toLowerCase()}, ${body.name}, ${body.password ? await hashPassword(body.password) : null}, ${body.role})`;
      // New teammates get the default grant on every existing LinkedIn account (none when DEFAULT_GRANT=NONE).
      if (config.defaultGrant !== 'NONE' && body.role !== 'AUDITOR') {
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
        role: z.enum(['ADMIN', 'MEMBER', 'AUDITOR']).optional(),
        disabled: z.boolean().optional(),
        password: z.string().min(10).max(200).optional(),
        /** Their own send limit per 24 hours; null = the team default, 0 = none. */
        dailySendCap: z.number().int().min(0).max(1000).nullable().optional(),
      })
      .parse(req.body);
    const [target] = await sql`SELECT id, role FROM users WHERE id = ${id}`;
    if (!target) throw new HttpError(404, 'User not found');
    if (target.role === 'OWNER' && (body.role || body.disabled)) throw new HttpError(400, 'The owner cannot be demoted or disabled');
    if (target.role === 'OWNER' && admin.role !== 'OWNER') throw new HttpError(403, 'Only the owner can change the owner');
    if (body.password) assertPasswordAllowed(target.role);

    if (body.name) await sql`UPDATE users SET name = ${body.name} WHERE id = ${id}`;
    if (body.dailySendCap !== undefined) await sql`UPDATE users SET daily_send_cap = ${body.dailySendCap} WHERE id = ${id}`;
    if (body.role) await sql`UPDATE users SET role = ${body.role} WHERE id = ${id}`;
    if (body.role === 'AUDITOR') await sql`DELETE FROM account_grants WHERE user_id = ${id}`; // auditors read the log only
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
    // Role, access or sessions changed: their open sockets reconnect (or are refused) with the new state.
    if (body.role || body.disabled || body.password) await publish(`user:${id}`, 'grants.changed', {});
    await audit({
      userId: admin.id,
      action: 'user.updated',
      meta: { targetUserId: id, ...body, password: body.password ? '***' : undefined },
      ip: req.ip,
    });
    return { ok: true };
  });

  // One staff member's LinkedIn accounts (Team → Accounts): every account, with their level or none.
  app.get('/api/users/:id/access', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    await assertStaff([id]);
    return sql`
      SELECT a.id AS account_id, a.label, a.display_name, a.status, g.level
      FROM accounts a LEFT JOIN account_grants g ON g.account_id = a.id AND g.user_id = ${id}
      ORDER BY a.label`;
  });

  app.put('/api/users/:id/access', async (req) => {
    const admin = requireAdmin(req);
    const { id } = req.params as { id: string };
    const body = z
      .array(z.object({ accountId: z.string(), level: Level.nullable() }))
      .max(500)
      .parse(req.body);
    await assertStaff([id]);
    return applyGrants(
      body.map((b) => ({ accountId: b.accountId, userId: id, level: b.level })),
      admin,
      req.ip,
    );
  });

  // Many at once: every chosen staff member gets the level (or loses access) on every chosen account.
  app.post('/api/users/access/bulk', async (req) => {
    const admin = requireAdmin(req);
    const body = z
      .object({
        userIds: z.array(z.string()).min(1).max(500),
        accountIds: z.array(z.string()).min(1).max(200),
        level: Level.nullable(),
      })
      .parse(req.body);
    await assertStaff(body.userIds);
    const changes = body.userIds.flatMap((userId) => body.accountIds.map((accountId) => ({ accountId, userId, level: body.level })));
    return applyGrants(changes, admin, req.ip);
  });

  // Staff send limits: the team default per 24 hours (0 = none) and when to alert admins about a burst.
  app.get('/api/settings/staff-limits', async (req) => {
    requireAdmin(req);
    return staffLimits();
  });

  app.put('/api/settings/staff-limits', async (req) => {
    const admin = requireAdmin(req);
    const body = z.object({ dailyCap: z.number().int().min(0).max(1000), burstPerHour: z.number().int().min(0).max(500) }).parse(req.body);
    await setStaffLimits(body);
    await audit({ userId: admin.id, action: 'settings.staff_limits', meta: body, ip: req.ip });
    return body;
  });

  // The owner hands ownership to a teammate and stays on as an admin.
  app.post('/api/users/:id/owner', async (req) => {
    const me = requireUser(req);
    if (me.role !== 'OWNER') throw new HttpError(403, 'Only the owner can hand over ownership');
    const { id } = req.params as { id: string };
    const [target] = await sql`SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id = ${id}`;
    if (!target) throw new HttpError(404, 'User not found');
    // The owner is the one who can still sign in when Microsoft is unavailable.
    if (config.passwordSignin === 'owner' && !target.hasPassword)
      throw new HttpError(409, 'Set a password for them first (scripts/set-owner.sh on the server does both)');
    await transferOwnership(id, me, req.ip);
    return { ok: true };
  });
}
