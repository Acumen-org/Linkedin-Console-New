import type { AuditAction } from '@linkedin-console/contracts';
import type { FastifyRequest } from 'fastify';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';

export interface AuditInput {
  userId?: string | null;
  accountId?: string | null;
  /** Account name to record when the account row no longer exists (e.g. it was just deleted). */
  accountLabel?: string | null;
  action: AuditAction;
  meta?: Record<string, unknown>;
  ip?: string | null;
  /** The request it came from: adds the browser (user agent). */
  req?: FastifyRequest;
}

/**
 * Append-only audit trail; failures are logged, never thrown. The teammate's name/email and the
 * account name are stored as they are now, so the entry stays readable after renames and removals.
 */
export async function audit(entry: AuditInput) {
  const userAgent = entry.req?.headers['user-agent']?.slice(0, 300) ?? null;
  try {
    await sql`
      INSERT INTO audit_log (user_id, account_id, action, meta, ip, user_agent, actor_name, actor_email, account_label)
      SELECT ${entry.userId ?? null}, a.id, ${entry.action}, ${sql.json((entry.meta ?? {}) as never)}, ${entry.ip ?? null}, ${userAgent},
             u.name, u.email, coalesce(${entry.accountLabel ?? null}, a.label)
      FROM (SELECT 1) one
      LEFT JOIN users u ON u.id = ${entry.userId ?? null}
      LEFT JOIN accounts a ON a.id = ${entry.accountId ?? null}`;
  } catch (err) {
    logger.error({ err, action: entry.action }, 'audit write failed');
  }
}
