// Shared identity for the external event feed (master plan C4): every outgoing event names the person by their
// LinkedIn profile link, the account, and the teammate by their work email. These refs are built the same way the
// CRM binding resolves a prospect (lib linkedin_members + contacts) — never by an automated profile fetch.
import { sql } from '../lib/db.ts';

/** How the feed identifies a person: vanity link when the public id is known, else whatever the connection row has. */
export interface PersonRef {
  memberUrn: string | null;
  /** The vanity id (jane-doe). Null when unknown — never looked up here (that would be an automated visit; see C8). */
  publicId: string | null;
  /** https://www.linkedin.com/in/<publicId>/ when known, else a stored link, else null. */
  profileUrl: string | null;
  name: string | null;
}
export interface AccountRef {
  id: string;
  /** The account's own LinkedIn name, falling back to its label. */
  name: string | null;
}
/** A teammate, identified by work email (several teammates share one account, so never derive this from the account). */
export interface UserRef {
  email: string | null;
  name: string | null;
}
export interface EventRefs {
  person: PersonRef;
  account: AccountRef;
  user: UserRef | null;
}

/** The person behind a member URN: public id + name from the member map / connection row, never fetched on demand. */
export async function personRef(accountId: string, memberUrn: string | null): Promise<PersonRef> {
  if (!memberUrn) return { memberUrn: null, publicId: null, profileUrl: null, name: null };
  const [m] = await sql`SELECT public_id FROM linkedin_members WHERE member_urn = ${memberUrn}`;
  const publicId = (m?.publicId as string | null) ?? null;
  // Name + any stored link from the connection row (by URN, or by the vanity id when the URN isn't backfilled yet).
  const [c] = await sql`
    SELECT name, profile_url FROM contacts
    WHERE account_id = ${accountId} AND (member_urn = ${memberUrn} ${publicId ? sql`OR public_id = ${publicId}` : sql``})
    ORDER BY (member_urn = ${memberUrn}) DESC NULLS LAST LIMIT 1`;
  const profileUrl = publicId ? `https://www.linkedin.com/in/${publicId}/` : ((c?.profileUrl as string | null) ?? null);
  return { memberUrn, publicId, profileUrl, name: (c?.name as string | null) ?? null };
}

/** The account's id + LinkedIn name (its label if no display name is stored). */
export async function accountRef(accountId: string): Promise<AccountRef> {
  const [a] = await sql`SELECT id, coalesce(display_name, label) AS name FROM accounts WHERE id = ${accountId}`;
  return a ? { id: a.id as string, name: (a.name as string | null) ?? null } : { id: accountId, name: null };
}

/** The teammate's email + name, or null when the actor is unknown (e.g. a request seen in a Sent list). */
export async function userRef(userId: string | null | undefined): Promise<UserRef | null> {
  if (!userId) return null;
  const [u] = await sql`SELECT email, name FROM users WHERE id = ${userId}`;
  return u ? { email: (u.email as string | null) ?? null, name: (u.name as string | null) ?? null } : null;
}

/** All three refs for one event (C4 backbone): the person, the account, and the teammate (when known). */
export async function eventRefs(accountId: string, memberUrn: string | null, userId: string | null | undefined): Promise<EventRefs> {
  const [person, account, user] = await Promise.all([personRef(accountId, memberUrn), accountRef(accountId), userRef(userId)]);
  return { person, account, user };
}
