import { sql } from './db.ts';

export async function audit(entry: { userId?: string | null; accountId?: string | null; action: string; meta?: Record<string, unknown>; ip?: string | null }) {
  await sql`
    INSERT INTO audit_log (user_id, account_id, action, meta, ip)
    VALUES (${entry.userId ?? null}, ${entry.accountId ?? null}, ${entry.action}, ${sql.json((entry.meta ?? {}) as never)}, ${entry.ip ?? null})`
    .catch((e) => console.error('[audit]', e.message));
}
