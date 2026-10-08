// Data in and out: importing LinkedIn's data archive, exporting chats.
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleAccountIds, assertAccount } from '../../core/access.ts';
import { importStatus, runImport } from '../../core/archive-import.ts';
import { audit } from '../../core/audit.ts';
import { requireAdmin, requireUser } from '../../core/auth.ts';
import { csvCell } from '../../lib/csv.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { redis } from '../../lib/redis.ts';

const MAX_IMPORT_BYTES = 200 * 1024 * 1024;

const EXPORT_HEADER = [
  'Conversation',
  'Conversation ID',
  'LinkedIn account',
  'Time (UTC)',
  'Direction',
  'From',
  'Sent by teammate',
  'Text',
  'Attachments',
];

export default async function dataRoutes(app: FastifyInstance) {
  /** Upload Connections.csv or messages.csv from LinkedIn's "Download my data" archive (runs in the background). */
  app.post('/api/accounts/:id/import', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await assertAccount(user, id, 'FULL');
    const part = await req.file({ limits: { fileSize: MAX_IMPORT_BYTES } });
    if (!part) throw new HttpError(400, 'No file');
    const buf = await part.toBuffer().catch(() => {
      throw new HttpError(413, 'File too large (max 200 MB)');
    });
    if (!(await redis.set(`lu:import:lock:${id}`, '1', 'EX', 3600, 'NX')))
      throw new HttpError(409, 'An import is already running for this account');
    const text = buf.toString('utf8');
    // In the background: a large archive takes a while. The page polls GET …/import.
    runImport(id, text)
      .then((s) =>
        audit({ userId: user.id, accountId: id, action: 'account.imported', meta: { file: part.filename, ...s }, ip: req.ip, req }),
      )
      .finally(() => redis.del(`lu:import:lock:${id}`));
    return { started: true };
  });

  app.get('/api/accounts/:id/import', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await assertAccount(user, id, 'FULL');
    return (await importStatus(id)) ?? { state: 'none' };
  });

  /**
   * The latest N conversations of the selected accounts with every stored message, newest conversation first
   * (CSV for Excel, or JSON). Admins only; every export is in the audit log.
   */
  app.get('/api/conversations/export', async (req, reply) => {
    const user = requireAdmin(req);
    const q = z
      .object({
        accountId: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(5000).default(100),
        format: z.enum(['csv', 'json']).default('csv'),
      })
      .parse(req.query);
    let ids = await accessibleAccountIds(user);
    if (q.accountId) ids = ids.filter((i) => i === q.accountId);
    if (!ids.length) throw new HttpError(404, 'No such account');

    async function* body() {
      let rows = 0;
      try {
        yield q.format === 'csv' ? `\uFEFF${EXPORT_HEADER.join(',')}\r\n` : '[\n';
        const cursor = sql`
          WITH latest AS (
            SELECT c.id, c.title, c.thread_id, c.participants, c.last_message_at, a.label
            FROM conversations c JOIN accounts a ON a.id = c.account_id
            WHERE c.account_id IN ${sql(ids)}
            ORDER BY c.last_message_at DESC NULLS LAST, c.id LIMIT ${q.limit}
          )
          SELECT l.id AS conversation_id, coalesce(l.title, l.participants->0->>'name', 'Conversation') AS conversation,
                 l.thread_id, l.label AS account, m.sent_at, m.direction, m.sender_name, u.name AS sent_by, m.text, m.attachments
          FROM latest l JOIN messages m ON m.conversation_id = l.id
          LEFT JOIN users u ON u.id = m.sent_by_user_id
          ORDER BY l.last_message_at DESC NULLS LAST, l.id, m.sent_at`.cursor(1000);
        for await (const batch of cursor) {
          let chunk = '';
          for (const m of batch) {
            const attachments = ((m.attachments ?? []) as { name?: string; kind?: string }[]).map((a) => a.name ?? a.kind).join('; ');
            const row = {
              conversation: m.conversation,
              conversationId: m.threadId,
              account: m.account,
              time: new Date(m.sentAt).toISOString(),
              direction: m.direction === 'OUTBOUND' ? 'Sent' : 'Received',
              from: m.direction === 'OUTBOUND' ? (m.sentBy ? `${m.sentBy} (via ${m.account})` : m.account) : m.senderName,
              sentByTeammate: m.sentBy,
              text: m.text,
              attachments,
            };
            chunk += q.format === 'csv' ? `${Object.values(row).map(csvCell).join(',')}\r\n` : `${rows ? ',\n' : ''}${JSON.stringify(row)}`;
            rows++;
          }
          yield chunk;
        }
        if (q.format === 'json') yield '\n]\n';
      } finally {
        await audit({ userId: user.id, action: 'conversations.exported', meta: { ...q, rows }, ip: req.ip, req });
      }
    }

    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    reply
      .header('content-type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="chats-${stamp}.${q.format}"`)
      .header('cache-control', 'no-store');
    return reply.send(Readable.from(body()));
  });
}
