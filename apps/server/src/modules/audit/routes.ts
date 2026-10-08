import { Readable } from 'node:stream';
import { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_EXPORT_FORMATS, type AuditEntry, auditLabel } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { requireAdmin } from '../../core/auth.ts';
import { sql } from '../../lib/db.ts';
import { badRequest } from '../../lib/errors.ts';

const Filters = z.object({
  userId: z.string().max(64).optional(),
  accountId: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
type Filters = z.infer<typeof Filters>;

const COLUMNS = sql`
  l.id, l.created_at, l.action, l.user_id, l.actor_name, l.actor_email, l.account_id, l.account_label,
  l.ip, l.user_agent, l.meta`;

/** The actions of a category, from the catalog (a category's actions don't all share its prefix). */
const actionsIn = (category: string) =>
  Object.entries(AUDIT_ACTIONS)
    .filter(([, a]) => a.category === category)
    .map(([code]) => code);

function where(f: Filters) {
  // 'auth' = the whole category, 'auth.login' = one action.
  const action = f.action
    ? Object.hasOwn(AUDIT_CATEGORIES, f.action)
      ? sql`AND l.action IN ${sql(actionsIn(f.action))}`
      : sql`AND l.action = ${f.action}`
    : sql``;
  return sql`
    WHERE true
      ${f.userId ? sql`AND l.user_id = ${f.userId}` : sql``}
      ${f.accountId ? sql`AND l.account_id = ${f.accountId}` : sql``}
      ${action}
      ${f.from ? sql`AND l.created_at >= ${f.from}` : sql``}
      ${f.to ? sql`AND l.created_at < ${f.to}` : sql``}`;
}

/** Cells starting with these are formulas in Excel/Sheets: prefix them so they stay text. */
const FORMULA = /^[=+\-@\t\r]/;
function csvCell(v: unknown) {
  let s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  if (FORMULA.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_HEADER = [
  'Time (UTC)',
  'Person',
  'Email',
  'Event',
  'Event code',
  'LinkedIn account',
  'Account ID',
  'IP address',
  'Browser',
  'Details',
];
const csvRow = (e: AuditEntry) =>
  [
    new Date(e.createdAt).toISOString(),
    e.actorName ?? (e.userId ? '' : 'System'),
    e.actorEmail,
    auditLabel(e.action),
    e.action,
    e.accountLabel,
    e.accountId ?? (e.meta?.accountId as string | undefined),
    e.ip,
    e.userAgent,
    Object.keys(e.meta ?? {}).length ? e.meta : '',
  ]
    .map(csvCell)
    .join(',');

export default async function auditRoutes(app: FastifyInstance) {
  app.get('/api/audit', async (req) => {
    requireAdmin(req);
    const q = Filters.extend({ before: z.coerce.number().int().optional() }).parse(req.query);
    return sql<AuditEntry[]>`
      SELECT ${COLUMNS} FROM audit_log l ${where(q)}
        ${q.before ? sql`AND l.id < ${q.before}` : sql``}
      ORDER BY l.id DESC LIMIT 100`;
  });

  /** The filtered log as a download, newest first, streamed in batches (any size). */
  app.get('/api/audit/export', async (req, reply) => {
    const user = requireAdmin(req);
    const q = Filters.extend({ format: z.enum(AUDIT_EXPORT_FORMATS).default('csv') }).parse(req.query);
    if (q.from && q.to && Date.parse(q.from) >= Date.parse(q.to)) throw badRequest('"From" must be before "to"');
    const filters: Filters = { userId: q.userId, accountId: q.accountId, action: q.action, from: q.from, to: q.to };

    async function* body() {
      let rows = 0;
      try {
        // CSV starts with a byte order mark so Excel reads it as UTF-8 (accented names).
        yield q.format === 'csv' ? `\uFEFF${CSV_HEADER.join(',')}\r\n` : '[\n';
        const cursor = sql<AuditEntry[]>`SELECT ${COLUMNS} FROM audit_log l ${where(filters)} ORDER BY l.id DESC`.cursor(1000);
        for await (const batch of cursor) {
          let chunk = '';
          for (const e of batch) {
            if (q.format === 'csv') chunk += `${csvRow(e)}\r\n`;
            else chunk += `${rows ? ',\n' : ''}${JSON.stringify({ ...e, event: auditLabel(e.action) })}`;
            rows++;
          }
          yield chunk;
        }
        if (q.format === 'json') yield '\n]\n';
      } finally {
        // The export itself is part of the record (who took a copy of what).
        await audit({ userId: user.id, action: 'audit.exported', meta: { format: q.format, rows, filters }, ip: req.ip, req });
      }
    }

    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    reply
      .header('content-type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="audit-log-${stamp}.${q.format}"`)
      .header('cache-control', 'no-store');
    return reply.send(Readable.from(body()));
  });
}
