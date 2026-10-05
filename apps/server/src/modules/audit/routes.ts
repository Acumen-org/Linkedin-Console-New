import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../../core/auth.ts';
import { sql } from '../../lib/db.ts';

export default async function auditRoutes(app: FastifyInstance) {
  app.get('/api/audit', async (req) => {
    requireAdmin(req);
    const q = z.object({ accountId: z.string().optional(), before: z.coerce.number().optional() }).parse(req.query);
    return sql`
      SELECT l.id, l.action, l.meta, l.ip, l.created_at, l.account_id, a.label AS account_label, u.name AS user_name
      FROM audit_log l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN accounts a ON a.id = l.account_id
      WHERE true
        ${q.accountId ? sql`AND l.account_id = ${q.accountId}` : sql``}
        ${q.before ? sql`AND l.id < ${q.before}` : sql``}
      ORDER BY l.id DESC LIMIT 100`;
  });
}
