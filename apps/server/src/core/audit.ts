import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';

export interface AuditEntry {
  userId?: string | null;
  accountId?: string | null;
  action: string;
  meta?: Record<string, unknown>;
  ip?: string | null;
}

/** Append-only audit trail; failures are logged, never thrown. */
export async function audit(entry: AuditEntry) {
  try {
    await sql`
      INSERT INTO audit_log (user_id, account_id, action, meta, ip)
      VALUES (${entry.userId ?? null}, ${entry.accountId ?? null}, ${entry.action}, ${sql.json((entry.meta ?? {}) as never)}, ${entry.ip ?? null})`;
  } catch (err) {
    logger.error({ err, action: entry.action }, 'audit write failed');
  }
}
