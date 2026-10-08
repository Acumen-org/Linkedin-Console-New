import { atLeast, LEVELS, type Level } from '@linkedin-console/contracts';
import { sql } from '../lib/db.ts';
import { HttpError } from '../lib/errors.ts';
import type { SessionUser } from './auth.ts';

/** OWNER/ADMIN can do everything; members need a grant per LinkedIn account. */
export async function accountLevel(user: SessionUser, accountId: string): Promise<Level | null> {
  const [a] = await sql`SELECT id FROM accounts WHERE id = ${accountId}`;
  if (!a) return null;
  if (user.role !== 'MEMBER') return 'FULL';
  const [g] = await sql`SELECT level FROM account_grants WHERE account_id = ${accountId} AND user_id = ${user.id}`;
  return (g?.level as Level) ?? null;
}

export async function assertAccount(user: SessionUser, accountId: string, min: Level): Promise<Level> {
  const level = await accountLevel(user, accountId);
  if (!level) throw new HttpError(404, 'Account not found');
  if (!atLeast(level, min)) throw new HttpError(403, `Needs ${min} access to this account`);
  return level;
}

export async function accessibleAccountIds(user: SessionUser, min: Level = 'READ'): Promise<string[]> {
  if (user.role !== 'MEMBER') return (await sql`SELECT id FROM accounts`).map((r) => r.id as string);
  const levels = LEVELS.filter((l) => atLeast(l, min));
  const rows = await sql`SELECT account_id FROM account_grants WHERE user_id = ${user.id} AND level IN ${sql(levels)}`;
  return rows.map((r) => r.accountId as string);
}

export async function conversationForUser(user: SessionUser, conversationId: string, min: Level) {
  const [c] = await sql`SELECT * FROM conversations WHERE id = ${conversationId}`;
  if (!c) throw new HttpError(404, 'Conversation not found');
  const level = await assertAccount(user, c.accountId, min);
  return { conversation: c, level };
}

/** Users who can read an account (notification recipients). */
export async function accountReaders(accountId: string): Promise<string[]> {
  const rows = await sql`
    SELECT u.id FROM users u
    LEFT JOIN account_grants g ON g.user_id = u.id AND g.account_id = ${accountId}
    WHERE u.disabled_at IS NULL AND (u.role <> 'MEMBER' OR g.level IS NOT NULL)`;
  return rows.map((r) => r.id as string);
}
