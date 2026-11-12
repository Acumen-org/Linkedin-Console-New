// Read-only external feed (ext plan C5), authenticated with an API key (Bearer) and nothing else — these routes never
// use the session, and the key works only here (its own preHandler, encapsulated to this plugin). GET only.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { verifyApiKey } from '../../core/ext-events.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { redis } from '../../lib/redis.ts';

export default async function extRoutes(app: FastifyInstance) {
  // Every route here requires a valid API key; this hook is scoped to this plugin, so no other route accepts the key.
  app.addHook('preHandler', async (req) => {
    const auth = String(req.headers.authorization ?? '');
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const keyId = key ? await verifyApiKey(key) : null;
    if (!keyId) throw new HttpError(401, 'A valid API key is required (Authorization: Bearer <key>)');
    // last_used_at is updated on every call; an audit-log entry is written at most hourly per key, to avoid flooding.
    if (await redis.set(`lu:extaudit:${keyId}`, '1', 'EX', 3600, 'NX')) {
      await audit({ action: 'ext.api_used', meta: { keyId }, ip: req.ip });
    }
  });

  // The replayable event feed, in seq order after a cursor.
  app.get('/api/ext/v1/events', async (req) => {
    const q = z
      .object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(500) })
      .parse(req.query);
    const rows = await sql<{ seq: string; type: string; at: Date; data: unknown }[]>`
      SELECT seq, type, at, data FROM ext_events WHERE seq > ${q.after} ORDER BY seq LIMIT ${q.limit}`;
    const nextCursor = rows.length ? Number(rows[rows.length - 1].seq) : q.after;
    return { events: rows.map((r) => ({ seq: Number(r.seq), type: r.type, at: r.at, ...(r.data as object) })), nextCursor };
  });

  // Current invitations (default: still pending).
  app.get('/api/ext/v1/invitations', async (req) => {
    const q = z.object({ status: z.enum(['pending', 'accepted', 'withdrawn']).default('pending') }).parse(req.query);
    const rows = await sql`
      SELECT id, account_id, member_urn, public_id, status, sent_at, accepted_at, withdrawn_at, source
      FROM invitations WHERE status = ${q.status} ORDER BY sent_at DESC LIMIT 2000`;
    return { invitations: rows };
  });

  // Accounts with this week's connection-request count (C6).
  app.get('/api/ext/v1/accounts', async () => {
    const rows = await sql<{ id: string; name: string | null; invitesLast7Days: number }[]>`
      SELECT a.id, coalesce(a.display_name, a.label) AS name,
             (SELECT count(*)::int FROM invitations i WHERE i.account_id = a.id AND i.sent_at > now() - interval '7 days') AS invites_last7_days
      FROM accounts a ORDER BY a.label`;
    return { accounts: rows.map((r) => ({ ...r, inviteWeeklyLimit: config.inviteWeeklyLimit })) };
  });
}
