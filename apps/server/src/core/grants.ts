// Assigning staff to LinkedIn accounts: per account (Accounts → Team access), per person (Team → Accounts) or
// many at once. Every way goes through here: only real changes are written and recorded (one audit entry per
// account, as on the account page), and the people concerned see the change at once.
import type { Level } from '@linkedin-console/contracts';
import { sql } from '../lib/db.ts';
import { HttpError } from '../lib/errors.ts';
import { publish } from '../lib/redis.ts';
import { audit } from './audit.ts';

export interface GrantChange {
  accountId: string;
  userId: string;
  level: Level | null;
}

/** Only staff get grants: admins and the owner see everything anyway, auditors nothing. */
export async function assertStaff(userIds: string[]) {
  if (!userIds.length) return;
  const rows = await sql`SELECT id, role FROM users WHERE id IN ${sql(userIds)}`;
  if (rows.length !== new Set(userIds).size) throw new HttpError(404, 'User not found');
  const other = rows.find((r) => r.role !== 'MEMBER');
  if (other) {
    throw new HttpError(
      400,
      other.role === 'AUDITOR'
        ? 'Auditors cannot be given access to LinkedIn accounts'
        : 'Admins and the owner already see every account; only staff are assigned',
    );
  }
}

export async function applyGrants(changes: GrantChange[], by: { id: string }, ip?: string) {
  if (!changes.length) return { changed: 0 };
  const accountIds = [...new Set(changes.map((c) => c.accountId))];
  const accounts = await sql`SELECT id FROM accounts WHERE id IN ${sql(accountIds)}`;
  if (accounts.length !== accountIds.length) throw new HttpError(404, 'Account not found');

  const current = await sql`
    SELECT account_id, user_id, level FROM account_grants
    WHERE account_id IN ${sql(accountIds)} AND user_id IN ${sql([...new Set(changes.map((c) => c.userId))])}`;
  const before = new Map(current.map((g) => [`${g.accountId}:${g.userId}`, g.level as Level]));
  const real = changes.filter((c) => (before.get(`${c.accountId}:${c.userId}`) ?? null) !== c.level);
  if (!real.length) return { changed: 0 };

  await sql.begin(async (tx) => {
    for (const c of real) {
      if (c.level) {
        await tx`
          INSERT INTO account_grants (account_id, user_id, level) VALUES (${c.accountId}, ${c.userId}, ${c.level})
          ON CONFLICT (account_id, user_id) DO UPDATE SET level = excluded.level`;
      } else {
        await tx`DELETE FROM account_grants WHERE account_id = ${c.accountId} AND user_id = ${c.userId}`;
      }
    }
  });
  for (const accountId of new Set(real.map((c) => c.accountId))) {
    const grants = real.filter((c) => c.accountId === accountId).map(({ userId, level }) => ({ userId, level }));
    await audit({ userId: by.id, accountId, action: 'account.grants_changed', meta: { grants }, ip });
  }
  for (const userId of new Set(real.map((c) => c.userId))) await publish(`user:${userId}`, 'grants.changed', {});
  return { changed: real.length };
}
