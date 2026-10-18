// Staff activity (admins and auditors): what each teammate sent, per LinkedIn account and date range, down to
// every message, with an export. Messages only: reading conversations is not tracked.
// Also the Twenty CRM sync status (admins).
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { requireAdmin, requireAuditAccess } from '../../core/auth.ts';
import { config } from '../../lib/config.ts';
import { csvCell } from '../../lib/csv.ts';
import { sql } from '../../lib/db.ts';
import { badRequest } from '../../lib/errors.ts';
import { crmSyncStatus, retryFailedCrm } from '../../worker/crm-sync.ts';

const Range = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  accountId: z.string().max(64).optional(),
});

/** Default: the last 30 days. */
function range(q: z.infer<typeof Range>) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400_000);
  if (from >= to) throw badRequest('"From" must be before "to"');
  return { from, to };
}

/** Messages a teammate sent from the app, in the range (and account). */
const sentWhere = (from: Date, to: Date, accountId?: string, userId?: string) => sql`
  m.sent_by_user_id IS NOT NULL AND m.direction = 'OUTBOUND' AND m.created_at >= ${from} AND m.created_at < ${to}
  ${accountId ? sql`AND m.account_id = ${accountId}` : sql``}
  ${userId ? sql`AND m.sent_by_user_id = ${userId}` : sql``}`;

const prospectName = sql`coalesce(c.title, (SELECT string_agg(p->>'name', ', ') FROM jsonb_array_elements(c.participants) p), 'LinkedIn Member')`;

export default async function activityRoutes(app: FastifyInstance) {
  app.get('/api/activity/staff', async (req) => {
    requireAuditAccess(req);
    const q = Range.parse(req.query);
    const { from, to } = range(q);
    const rows = await sql`
      WITH sent AS (
        SELECT m.sent_by_user_id, m.conversation_id, m.status, m.created_at,
               -- First message of the conversation = a new chat this teammate started.
               NOT EXISTS (SELECT 1 FROM messages p WHERE p.conversation_id = m.conversation_id AND p.sent_at < m.sent_at) AS opened,
               -- Did that new chat get a reply from the prospect afterwards (outreach that worked)?
               EXISTS (SELECT 1 FROM messages r WHERE r.conversation_id = m.conversation_id AND r.direction = 'INBOUND' AND r.sent_at > m.sent_at) AS got_reply,
               -- Time to reply: from the prospect's message just before this one (if the last word was theirs).
               (SELECT CASE WHEN p.direction = 'INBOUND' THEN extract(epoch FROM m.sent_at - p.sent_at) END
                FROM messages p WHERE p.conversation_id = m.conversation_id AND p.sent_at < m.sent_at
                ORDER BY p.sent_at DESC LIMIT 1) AS reply_seconds
        FROM messages m WHERE ${sentWhere(from, to, q.accountId)}
      ),
      -- Open follow-ups, charged to the teammate responsible for the conversation (its assignee, else who set it).
      followups AS (
        SELECT coalesce(c.assigned_to, r.created_by) AS user_id,
               count(*)::int AS open,
               count(*) FILTER (WHERE r.due_at <= now())::int AS overdue
        FROM reminders r JOIN conversations c ON c.id = r.conversation_id
        WHERE r.status = 'OPEN' ${q.accountId ? sql`AND r.account_id = ${q.accountId}` : sql``}
        GROUP BY coalesce(c.assigned_to, r.created_by)
      ),
      -- Chats this teammate opened (read) in the range.
      reads AS (
        SELECT user_id, count(DISTINCT conversation_id)::int AS chats_read
        FROM conversation_views
        WHERE viewed_at >= ${from} AND viewed_at < ${to} ${q.accountId ? sql`AND account_id = ${q.accountId}` : sql``}
        GROUP BY user_id
      )
      SELECT u.id, u.name, u.email, u.role, u.disabled_at, u.pod,
             count(s.*) FILTER (WHERE s.status = 'SENT')::int AS sent,
             count(s.*) FILTER (WHERE s.status = 'FAILED')::int AS failed,
             count(DISTINCT s.conversation_id)::int AS conversations,
             count(DISTINCT s.conversation_id) FILTER (WHERE s.opened AND s.status = 'SENT')::int AS new_chats,
             count(DISTINCT s.conversation_id) FILTER (WHERE s.opened AND s.status = 'SENT' AND s.got_reply)::int AS replies,
             round(percentile_cont(0.5) WITHIN GROUP (ORDER BY s.reply_seconds) / 60)::int AS median_reply_minutes,
             coalesce(f.open, 0) AS followups_open,
             coalesce(f.overdue, 0) AS followups_overdue,
             coalesce(rd.chats_read, 0) AS chats_read,
             max(s.created_at) AS last_active_at
      FROM users u
      LEFT JOIN sent s ON s.sent_by_user_id = u.id
      LEFT JOIN followups f ON f.user_id = u.id
      LEFT JOIN reads rd ON rd.user_id = u.id
      WHERE u.role <> 'AUDITOR'
      GROUP BY u.id, f.open, f.overdue, rd.chats_read
      HAVING count(s.*) > 0 OR coalesce(f.open, 0) > 0 OR coalesce(rd.chats_read, 0) > 0 OR (u.role = 'MEMBER' AND u.disabled_at IS NULL)
      ORDER BY count(s.*) DESC, u.name`;
    return { from: from.toISOString(), to: to.toISOString(), staff: rows };
  });

  // Everything one teammate sent in the range, newest first, 100 at a time (cursor: the last row's time + id).
  app.get('/api/activity/staff/:userId/messages', async (req) => {
    requireAuditAccess(req);
    const { userId } = req.params as { userId: string };
    const q = Range.extend({ before: z.iso.datetime({ offset: true }).optional(), beforeId: z.string().max(64).optional() }).parse(
      req.query,
    );
    const { from, to } = range(q);
    return sql`
      SELECT m.id, m.created_at, m.sent_at, m.status, m.error, m.text, m.attachments, m.conversation_id,
             a.label AS account_label, ${prospectName} AS prospect
      FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN accounts a ON a.id = m.account_id
      WHERE ${sentWhere(from, to, q.accountId, userId)}
        -- The cursor comes back from the browser in milliseconds: compare (and sort) at that precision.
        ${q.before ? sql`AND (date_trunc('milliseconds', m.created_at), m.id) < (${q.before}::timestamptz, ${q.beforeId ?? ''})` : sql``}
      ORDER BY date_trunc('milliseconds', m.created_at) DESC, m.id DESC LIMIT 100`;
  });

  app.get('/api/activity/export', async (req, reply) => {
    const user = requireAuditAccess(req);
    const q = Range.extend({ userId: z.string().max(64).optional(), format: z.enum(['csv', 'json']).default('csv') }).parse(req.query);
    const { from, to } = range(q);
    const HEADER = ['Time (UTC)', 'Staff', 'Staff email', 'LinkedIn account', 'Prospect', 'Status', 'Message', 'Error', 'Conversation'];

    async function* body() {
      let rows = 0;
      try {
        // CSV starts with a byte order mark so Excel reads it as UTF-8 (accented names).
        yield q.format === 'csv' ? `﻿${HEADER.join(',')}\r\n` : '[\n';
        const cursor = sql`
          SELECT m.created_at, u.name AS staff, u.email AS staff_email, a.label AS account, ${prospectName} AS prospect,
                 m.status, m.text, m.error, m.conversation_id
          FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN accounts a ON a.id = m.account_id
          JOIN users u ON u.id = m.sent_by_user_id
          WHERE ${sentWhere(from, to, q.accountId, q.userId)}
          ORDER BY m.created_at DESC`.cursor(1000);
        for await (const batch of cursor) {
          let chunk = '';
          for (const r of batch) {
            const link = config.appUrl ? `${config.appUrl}/inbox/${r.conversationId}` : r.conversationId;
            if (q.format === 'csv') {
              const cells = [
                (r.createdAt as Date).toISOString(),
                r.staff,
                r.staffEmail,
                r.account,
                r.prospect,
                r.status,
                r.text,
                r.error,
                link,
              ];
              chunk += `${cells.map(csvCell).join(',')}\r\n`;
            } else {
              chunk += `${rows ? ',\n' : ''}${JSON.stringify({ ...r, conversation: link })}`;
            }
            rows++;
          }
          yield chunk;
        }
        if (q.format === 'json') yield '\n]\n';
      } finally {
        await audit({
          userId: user.id,
          accountId: q.accountId,
          action: 'activity.exported',
          meta: { format: q.format, rows, from: from.toISOString(), to: to.toISOString(), staffUserId: q.userId },
          ip: req.ip,
          req,
        });
      }
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    reply
      .header('content-type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="staff-activity-${stamp}.${q.format}"`)
      .header('cache-control', 'no-store');
    return reply.send(Readable.from(body()));
  });

  app.get('/api/crm/status', async (req) => {
    requireAdmin(req);
    return crmSyncStatus();
  });

  app.post('/api/crm/retry', async (req) => {
    const user = requireAdmin(req);
    if (!config.crmSync) throw badRequest('The Twenty CRM sync is off (CRM_SYNC)');
    const retried = await retryFailedCrm();
    await audit({ userId: user.id, action: 'crm.retried', meta: { messages: retried }, ip: req.ip });
    return { retried };
  });
}
