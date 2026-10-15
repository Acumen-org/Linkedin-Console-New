// Who a prospect is in Twenty CRM (master plan L1, L5): nothing about a prospect reaches Twenty until they reply
// and are bound to exactly one Person. Bound automatically only when exactly one Person has their LinkedIn
// profile link (that can't create a duplicate); otherwise the conversation waits in "Needs CRM binding" for a
// teammate to bind it to an existing Person or add a new one. Never by name, never by email. A binding belongs
// to the prospect (LinkedIn member URN), so every conversation with them goes to the same Person.
import { accountRoom } from '@linkedin-console/contracts';
import { audit } from '../core/audit.ts';
import { sql } from '../lib/db.ts';
import { publish } from '../lib/redis.ts';
import { linkedinKey, peopleWithLinkedin, updatePerson } from '../lib/twenty.ts';
import { CONSOLE_SOURCE, personHasField } from '../lib/twenty-fields.ts';
import { loadConversation } from '../modules/conversations/queries.ts';

export type BindMethod = 'auto_link' | 'existing' | 'new';

type Participant = { urn?: string; name?: string; headline?: string | null; profileUrl?: string | null };

/** The prospect of a 1:1 conversation, with the vanity profile link from the connections list when known. */
export async function prospectOf(accountId: string, participants: Participant[]) {
  const p = participants[0] ?? {};
  const [contact] = p.urn
    ? await sql`SELECT profile_url, headline, is_connection FROM contacts WHERE account_id = ${accountId} AND member_urn = ${p.urn} LIMIT 1`
    : [];
  return {
    memberUrn: p.urn?.startsWith('urn:li:') ? p.urn : null,
    name: p.name?.trim() || 'LinkedIn Member',
    profileUrl: (contact?.profileUrl as string | null) ?? p.profileUrl ?? null,
    headline: (contact?.headline as string | null) ?? p.headline ?? null,
    connected: !!contact?.isConnection,
  };
}

async function changed(conversations: { id: string; accountId: string }[]) {
  for (const c of conversations) await publish(accountRoom(c.accountId), 'conversation.updated', await loadConversation(c.id));
}

/** Binds the prospect to a Person: every 1:1 conversation with them, in every account. */
export async function bindProspect(memberUrn: string, personId: string, method: BindMethod, by: { id: string } | null, ip?: string) {
  await sql`
    INSERT INTO crm_bindings (member_urn, person_id, method, bound_by)
    VALUES (${memberUrn}, ${personId}, ${method}, ${by?.id ?? null})
    ON CONFLICT (member_urn) DO UPDATE SET person_id = excluded.person_id, method = excluded.method,
      bound_by = excluded.bound_by, bound_at = now()`;
  const convs = await applyBinding(memberUrn, personId, true);
  await audit({ userId: by?.id ?? null, accountId: convs[0]?.accountId, action: 'crm.bound', meta: { memberUrn, personId, method }, ip });
}

/**
 * Every 1:1 conversation with the prospect points at their Person (also ones that started after the binding).
 * `all`: also the ones already bound (a new binding replaces the old one).
 */
async function applyBinding(memberUrn: string, personId: string, all = false) {
  const convs = await sql<{ id: string; accountId: string }[]>`
    UPDATE conversations SET twenty_person_id = ${personId}, crm_binding = 'bound', crm_binding_reason = NULL, crm_binding_at = now()
    WHERE participants->0->>'urn' = ${memberUrn} AND NOT is_group ${all ? sql`` : sql`AND crm_binding IS DISTINCT FROM 'bound'`}
    RETURNING id, account_id`;
  await changed(convs);
  return convs;
}

/** The Person is gone from Twenty (deleted or merged): the prospect is looked at again from scratch. */
export async function unbindProspect(memberUrn: string, reason: string) {
  await sql`DELETE FROM crm_bindings WHERE member_urn = ${memberUrn}`;
  const convs = await sql<{ id: string; accountId: string }[]>`
    UPDATE conversations SET twenty_person_id = NULL, crm_binding = NULL, crm_binding_reason = NULL, crm_binding_at = now()
    WHERE participants->0->>'urn' = ${memberUrn} AND NOT is_group
    RETURNING id, account_id`;
  await audit({ accountId: convs[0]?.accountId, action: 'crm.unbound', meta: { memberUrn, reason } });
  await changed(convs);
}

async function needsBinding(c: { id: string; accountId: string }, reason: string) {
  await sql`
    UPDATE conversations SET crm_binding = 'needed', crm_binding_reason = ${reason}, crm_binding_at = now()
    WHERE id = ${c.id} AND crm_binding IS DISTINCT FROM 'bound'`;
  await changed([c]);
}

/** A "needs binding" decision is looked at again after this long (or as soon as new profile data arrives). */
const RECHECK_HOURS = 6;

/**
 * Prospects who replied and aren't decided yet: bound when exactly one Person has their profile link (or they
 * are already bound through another conversation), else queued for a teammate. A few per tick.
 */
export async function bindReplied(limit = 10) {
  const candidates = await sql<{ id: string; accountId: string; participants: Participant[] }[]>`
    SELECT c.id, c.account_id, c.participants FROM conversations c
    WHERE NOT c.is_group AND c.participants->0->>'urn' LIKE 'urn:li:%'
      AND (c.crm_binding IS NULL OR (c.crm_binding = 'needed' AND c.crm_binding_at < now() - make_interval(hours => ${RECHECK_HOURS})))
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'INBOUND')
    ORDER BY c.last_message_at DESC NULLS LAST LIMIT ${limit}`;
  let bound = 0;
  for (const c of candidates) {
    const prospect = await prospectOf(c.accountId, c.participants ?? []);
    const memberUrn = prospect.memberUrn as string;
    // Already bound through another conversation (another account or teammate): the same Person.
    const [known] = await sql`SELECT person_id FROM crm_bindings WHERE member_urn = ${memberUrn}`;
    if (known) {
      await applyBinding(memberUrn, known.personId);
      bound++;
      continue;
    }
    if (!linkedinKey(prospect.profileUrl)) {
      await needsBinding(c, 'No LinkedIn profile link known yet');
      continue;
    }
    const people = await peopleWithLinkedin(prospect.profileUrl as string);
    if (people.length === 1) {
      await bindProspect(memberUrn, people[0], 'auto_link', null);
      bound++;
    } else if (people.length === 0) {
      await needsBinding(c, 'Not in Twenty yet (no Person has this LinkedIn profile)');
    } else {
      await needsBinding(c, `${people.length} Persons in Twenty have this LinkedIn profile`);
    }
  }
  return bound;
}

/**
 * Persons the earlier sync created for prospects who never replied: marked "LinkedIn Console: review" in Twenty
 * for CS to clean up (nothing is deleted). Waits until that field exists (scripts/twenty-fields.sh).
 */
export async function markForReview(limit = 10) {
  const due = await sql`
    SELECT DISTINCT crm_review_person_id AS person_id FROM conversations
    WHERE crm_review_person_id IS NOT NULL AND crm_review_marked_at IS NULL LIMIT ${limit}`;
  if (!due.length || !(await personHasField('linkedinConsoleSource'))) return 0;
  for (const { personId } of due) {
    // The prospect replied since and was bound to this very Person: it's a real contact now, not a review case.
    const [bound] = await sql`SELECT 1 FROM crm_bindings WHERE person_id = ${personId}`;
    if (!bound) await updatePerson(personId, { linkedinConsoleSource: CONSOLE_SOURCE.REVIEW });
    await sql`UPDATE conversations SET crm_review_marked_at = now() WHERE crm_review_person_id = ${personId}`;
  }
  return due.length;
}
