import { sql } from './db.ts';
import { HttpError, type User } from './auth.ts';
import type { Level } from './config.ts';

const RANK: Record<Level, number> = { READ: 1, REPLY: 2, FULL: 3 };

/** OWNER/ADMIN can do everything; members need a grant per LinkedIn account. */
export async function accountLevel(user: User, accountId: string): Promise<Level | null> {
  const [a] = await sql`SELECT id FROM accounts WHERE id = ${accountId}`;
  if (!a) return null;
  if (user.role !== 'MEMBER') return 'FULL';
  const [g] = await sql`SELECT level FROM account_grants WHERE account_id = ${accountId} AND user_id = ${user.id}`;
  return (g?.level as Level) ?? null;
}

export async function assertAccount(user: User, accountId: string, min: Level): Promise<Level> {
  const level = await accountLevel(user, accountId);
  if (!level) throw new HttpError(404, 'Account not found');
  if (RANK[level] < RANK[min]) throw new HttpError(403, `Needs ${min} access to this account`);
  return level;
}

export async function accessibleAccountIds(user: User, min: Level = 'READ'): Promise<string[]> {
  if (user.role !== 'MEMBER') return (await sql`SELECT id FROM accounts`).map((r) => r.id as string);
  const levels = (Object.keys(RANK) as Level[]).filter((l) => RANK[l] >= RANK[min]);
  return (await sql`SELECT account_id FROM account_grants WHERE user_id = ${user.id} AND level IN ${sql(levels)}`).map((r) => r.accountId as string);
}

export async function conversationForUser(user: User, conversationId: string, min: Level) {
  const [c] = await sql`SELECT * FROM conversations WHERE id = ${conversationId}`;
  if (!c) throw new HttpError(404, 'Conversation not found');
  const level = await assertAccount(user, c.accountId, min);
  return { conversation: c, level };
}

export const atLeast = (level: Level | null, min: Level) => !!level && RANK[level] >= RANK[min];
