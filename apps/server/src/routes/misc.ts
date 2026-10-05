import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.ts';
import { audit } from '../audit.ts';
import { redis } from '../redis.ts';
import { ACCOUNT_ID_RE } from '../ids.ts';
import { COOKIE, HttpError, requireAdmin, requireUser, userFromToken } from '../auth.ts';
import { assertAccount, accountLevel } from '../access.ts';
import { sendCommand } from '../bridgeClient.ts';

export default async function miscRoutes(app: FastifyInstance) {
  // ---------- connections ----------
  app.get('/api/accounts/:id/connections', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await assertAccount(user, id, 'READ');
    const q = z.object({ q: z.string().max(200).optional(), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const term = q.q?.trim();
    const rows = await sql`
      SELECT id, public_id, name, headline, avatar_url, profile_url, updated_at FROM contacts
      WHERE account_id = ${id} AND is_connection
        ${term ? sql`AND (name ILIKE ${'%' + term + '%'} OR headline ILIKE ${'%' + term + '%'})` : sql``}
      ORDER BY name LIMIT 100 OFFSET ${q.offset}`;
    const [{ total }] = await sql`SELECT count(*)::int AS total FROM contacts WHERE account_id = ${id} AND is_connection`;
    return { total, items: rows };
  });

  app.post('/api/accounts/:id/connections/:contactId/message', async (req) => {
    const user = requireUser(req);
    const { id, contactId } = req.params as { id: string; contactId: string };
    await assertAccount(user, id, 'REPLY');
    const { text } = z.object({ text: z.string().min(1).max(8000) }).parse(req.body);
    const [c] = await sql`SELECT * FROM contacts WHERE id = ${contactId} AND account_id = ${id}`;
    if (!c?.profileUrl) throw new HttpError(404, 'Connection not found');
    const [a] = await sql`SELECT status, send_paused FROM accounts WHERE id = ${id}`;
    if (a.status !== 'CONNECTED' || a.sendPaused) throw new HttpError(409, 'This LinkedIn account cannot send right now');
    // The new conversation arrives through the bridge; remember who sent it for "sent by".
    await redis.lpush(`li:pending:${id}`, JSON.stringify({ text, userId: user.id, at: Date.now() }));
    await redis.ltrim(`li:pending:${id}`, 0, 50);
    await redis.expire(`li:pending:${id}`, 3600);
    const cmdId = await sendCommand(id, { type: 'start_chat', profileUrl: c.profileUrl, text }, user.id);
    await audit({ userId: user.id, accountId: id, action: 'message.start_chat', meta: { contactId, chars: text.length }, ip: req.ip });
    return { ok: true, cmdId };
  });

  // ---------- Live View gate (Caddy forward_auth) ----------
  // FULL → can control, REPLY → view only, READ → no access.
  // The account owner can always open it while the account still needs a login.
  app.get('/api/live/auth', async (req, reply) => {
    const user = await userFromToken(req.cookies[COOKIE]);
    if (!user) return reply.code(401).send('unauthorized');
    const uri = String(req.headers['x-forwarded-uri'] ?? '');
    const accountId = uri.match(/^\/live\/([a-z0-9]{12})(\/|$)/)?.[1];
    if (!accountId || !ACCOUNT_ID_RE.test(accountId)) return reply.code(404).send('not found');
    const level = await accountLevel(user, accountId);
    const [a] = await sql`SELECT owner_user_id, status FROM accounts WHERE id = ${accountId}`;
    if (!a) return reply.code(404).send('not found');
    const ownerLogin = a.ownerUserId === user.id && a.status !== 'CONNECTED';
    const control = level === 'FULL' || ownerLogin;
    if (!control && level !== 'REPLY') return reply.code(403).send('forbidden');

    if (await redis.set(`lu:liveaudit:${user.id}:${accountId}`, '1', 'EX', 1800, 'NX')) {
      await audit({ userId: user.id, accountId, action: 'live.opened', meta: { control }, ip: String(req.headers['x-forwarded-for'] ?? req.ip) });
    }
    reply.header('X-LU-User', encodeURIComponent(user.name));
    reply.header('X-LU-Control', control ? '1' : '0');
    return reply.code(200).send('ok');
  });

  // ---------- audit ----------
  app.get('/api/audit', async (req) => {
    requireAdmin(req);
    const q = z.object({ accountId: z.string().optional(), before: z.coerce.number().optional() }).parse(req.query);
    return sql`
      SELECT l.id, l.action, l.meta, l.ip, l.created_at, l.account_id, a.label AS account_label, u.name AS user_name
      FROM audit_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN accounts a ON a.id = l.account_id
      WHERE true ${q.accountId ? sql`AND l.account_id = ${q.accountId}` : sql``} ${q.before ? sql`AND l.id < ${q.before}` : sql``}
      ORDER BY l.id DESC LIMIT 100`;
  });
}
