// Who a prospect is in Twenty CRM (master plan L1, L5): nothing about a prospect reaches Twenty until they reply
// and are bound to exactly one Person. Bound automatically only when exactly one Person has their LinkedIn
// profile link (that can't create a duplicate); otherwise the conversation waits in "Needs CRM binding" for a
// teammate to bind it to an existing Person or add a new one. Never by name, never by email. A binding belongs
// to the prospect (LinkedIn member URN), so every conversation with them goes to the same Person.
import { accountRoom, type ResolveProfileReply } from '@linkedin-console/contracts';
import { audit } from '../core/audit.ts';
import { requestCommand } from '../core/bridge.ts';
import { RESPONSIBLE } from '../core/reminders-sql.ts';
import { addBusinessDays } from '../lib/business-days.ts';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { HttpError } from '../lib/errors.ts';
import { disableAutoCreate } from '../lib/integrations.ts';
import { logger } from '../lib/logger.ts';
import { decide, rankCandidates } from '../lib/match-score.ts';
import { publish } from '../lib/redis.ts';
import {
  createPerson,
  deleteConversationRecordsForPerson,
  deletePersonInTwenty,
  linkedinKey,
  peopleWithLinkedin,
  personById,
  personByLinkedinMemberId,
  searchPeople,
  updatePerson,
} from '../lib/twenty.ts';
import { CONSOLE_SOURCE, personFieldType, personHasField } from '../lib/twenty-fields.ts';
import { loadConversation } from '../modules/conversations/queries.ts';
import { pushToUsers } from './push.ts';

/** Every binding method, as the DB's crm_bindings.method CHECK must also allow (migrations 029, 030). This is the
 * single source: BindMethod derives from it, and an e2e test inserts each one so a value added here without a matching
 * migration fails CI — the drift that caused the auto-create orphan storm (auto_new in code, not in the CHECK). */
export const BIND_METHODS = ['auto_link', 'auto_new', 'auto_score', 'existing', 'new', 'legacy'] as const;
export type BindMethod = (typeof BIND_METHODS)[number];

type Participant = { urn?: string; name?: string; headline?: string | null; profileUrl?: string | null };

/** The prospect of a 1:1 conversation, with the vanity profile link from the connections list when known. */
export async function prospectOf(accountId: string, participants: Participant[]) {
  const p = participants[0] ?? {};
  const urn = p.urn?.startsWith('urn:li:') ? p.urn : null;
  // The prospect's connection row, found by their member URN directly, or — because the connections list carries
  // only the vanity id — through the member↔vanity map, which also backfills contacts.member_urn once bridged.
  const [contact] = urn
    ? await sql`
        SELECT c.profile_url, c.headline, c.is_connection FROM contacts c
        WHERE c.account_id = ${accountId}
          AND (c.member_urn = ${urn} OR c.public_id = (SELECT public_id FROM linkedin_members WHERE member_urn = ${urn}))
        ORDER BY (c.member_urn = ${urn}) DESC NULLS LAST LIMIT 1`
    : [];
  // Even with no connection row, the map may know the prospect's vanity profile (e.g. resolved on demand): that
  // vanity link is what matches a Twenty Person, where the raw member-URN URL never would.
  const [mapped] = urn && !contact?.profileUrl ? await sql`SELECT public_id FROM linkedin_members WHERE member_urn = ${urn}` : [];
  const vanity = mapped ? `https://www.linkedin.com/in/${mapped.publicId}/` : null;
  return {
    memberUrn: urn,
    name: p.name?.trim() || 'LinkedIn Member',
    profileUrl: (contact?.profileUrl as string | null) ?? vanity ?? p.profileUrl ?? null,
    headline: (contact?.headline as string | null) ?? p.headline ?? null,
    connected: !!contact?.isConnection,
  };
}

/**
 * Records member-URN ↔ vanity-public-id pairs (from a profile resolution or any payload that carries both). Also
 * backfills contacts.member_urn for the matching connection rows, and wakes the prospects who were waiting only
 * because their vanity link was unknown, so the next bindReplied tick looks at them again.
 */
export async function rememberMembers(pairs: { memberUrn: string; publicId: string }[], source: string) {
  const rows = pairs.filter((m) => m.memberUrn?.startsWith('urn:li:') && m.publicId);
  if (!rows.length) return;
  await sql`
    INSERT INTO linkedin_members ${sql(
      rows.map((m) => ({ memberUrn: m.memberUrn, publicId: m.publicId, source })) as never,
      'memberUrn',
      'publicId',
      'source',
    )}
    ON CONFLICT (member_urn) DO UPDATE SET public_id = excluded.public_id, source = excluded.source, updated_at = now()`;
  // Fill in the member URN on the connection rows we only knew by vanity id (every account), so later lookups and
  // other features (search, status) find them directly.
  await sql`
    UPDATE contacts c SET member_urn = lm.member_urn, updated_at = now()
    FROM linkedin_members lm WHERE lm.public_id = c.public_id AND c.member_urn IS NULL AND lm.member_urn IN ${sql(rows.map((m) => m.memberUrn))}`;
  // Replies queued only for a missing profile link are looked at again right away (as onContacts does for new links).
  await sql`
    UPDATE conversations SET crm_binding = NULL
    WHERE crm_binding = 'needed' AND crm_binding_at <> 'infinity' AND participants->0->>'urn' IN ${sql(rows.map((m) => m.memberUrn))}`;
}

async function changed(conversations: { id: string; accountId: string }[]) {
  for (const c of conversations) await publish(accountRoom(c.accountId), 'conversation.updated', await loadConversation(c.id));
}

/** Binds the prospect to a Person: every 1:1 conversation with them, in every account. `extra` adds to the audit meta
 * (e.g. the match score + reason for a fuzzy auto_score bind, so it can be reviewed and undone if wrong). */
export async function bindProspect(
  memberUrn: string,
  personId: string,
  method: BindMethod,
  by: { id: string } | null,
  ip?: string,
  extra?: Record<string, unknown>,
) {
  await sql`
    INSERT INTO crm_bindings (member_urn, person_id, method, bound_by)
    VALUES (${memberUrn}, ${personId}, ${method}, ${by?.id ?? null})
    ON CONFLICT (member_urn) DO UPDATE SET person_id = excluded.person_id, method = excluded.method,
      bound_by = excluded.bound_by, bound_at = now()`;
  const convs = await applyBinding(memberUrn, personId, true);
  await audit({
    userId: by?.id ?? null,
    accountId: convs[0]?.accountId,
    action: 'crm.bound',
    meta: { memberUrn, personId, method, ...extra },
    ip,
  });
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

/** At most this many LinkedIn profile lookups per tick (member URN → vanity), to stay gentle on the account. */
const RESOLVE_PER_TICK = 3;
/** The obfuscated member-id form in a replier's profile URL (/in/ACoAA…), which no Twenty vanity link matches. */
const OBFUSCATED_URL = /\/in\/ACoA[A-Za-z0-9_-]+\/?$/i;

/**
 * Asks the account's bridge for a replier's vanity id (obfuscated member URN → publicIdentifier) and caches the
 * pair in linkedin_members, returning the vanity profile link a Twenty Person can match. Only for a connected
 * account; a bridge that is busy or offline just means we try again on the next recheck (never aborts the tick).
 */
async function resolveVanityUrl(accountId: string, memberUrn: string): Promise<string | null> {
  const [acct] = await sql`SELECT status FROM accounts WHERE id = ${accountId}`;
  if (acct?.status !== 'CONNECTED') return null;
  try {
    const reply = await requestCommand<ResolveProfileReply>(accountId, { type: 'resolve_profile', memberUrn }, 30);
    if (reply.ok && reply.publicId) {
      await rememberMembers([{ memberUrn, publicId: reply.publicId }], 'resolved');
      return `https://www.linkedin.com/in/${reply.publicId}/`;
    }
  } catch {
    // Bridge busy or offline: leave the prospect queued; the next recheck resolves them.
  }
  return null;
}

/**
 * Circuit breaker: the most Persons auto-create may make in a rolling hour. Legitimate backfill is well under this;
 * anything above it is a runaway (a bug, a dedup miss), so auto-create pauses itself and alerts instead of continuing.
 * The 2026-10-22 incident made ~5,000 before anyone noticed — this caps a future one at ~this many.
 */
const CREATE_CAP_PER_HOUR = 100;

/** Scored-binding (dry-run for now): a candidate auto-binds only at/above this score AND beating the runner-up by the
 * margin. Starts at 90 per the plan (lower to 80 after the dry-run looks clean). Only used to LOG the decision today. */
const MATCH_THRESHOLD = 90;
const MATCH_MARGIN = 15;

/** Auto-create just hit the hourly cap: turn it off (persisted) so it can't continue, record it, and alert admins. */
async function tripCreateBreaker(lastHour: number) {
  await disableAutoCreate().catch((err) => logger.error({ err }, 'failed to pause auto-create at the cap'));
  await audit({ action: 'crm.autocreate_paused', meta: { createdLastHour: lastHour, cap: CREATE_CAP_PER_HOUR } });
  const admins = await sql<{ id: string }[]>`SELECT id FROM users WHERE role IN ('OWNER', 'ADMIN') AND disabled_at IS NULL`;
  await pushToUsers(
    admins.map((a) => a.id),
    {
      title: 'Auto-create paused (safety limit)',
      body: `${lastHour} people were created in Twenty in the last hour, hitting the ${CREATE_CAP_PER_HOUR} cap. Auto-create was turned off — check for a problem before re-enabling.`,
      url: '/settings',
      tag: 'crm-breaker',
    },
  ).catch(() => {});
  logger.error({ lastHour, cap: CREATE_CAP_PER_HOUR }, 'auto-create hit the hourly cap and was paused');
}

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
  let resolved = 0;
  const tried = new Set<string>();
  // Circuit breaker: how many Persons auto-create has already made this hour. Once the cap is reached we stop creating
  // (and pause the feature), so a runaway can't exceed it no matter the cause.
  const [{ recentCreates }] = await sql<{ recentCreates: number }[]>`
    SELECT count(*)::int AS recent_creates FROM crm_bindings WHERE method = 'auto_new' AND bound_at > now() - interval '1 hour'`;
  let createsThisRun = 0;
  for (const c of candidates) {
    try {
      const prospect = await prospectOf(c.accountId, c.participants ?? []);
      const memberUrn = prospect.memberUrn as string;
      // Already bound through another conversation (another account or teammate): the same Person.
      const [known] = await sql`SELECT person_id FROM crm_bindings WHERE member_urn = ${memberUrn}`;
      if (known) {
        await applyBinding(memberUrn, known.personId);
        bound++;
        continue;
      }
      let profileUrl = prospect.profileUrl;
      // Known only by their obfuscated member URN (no connection row, not resolved before): look up their vanity
      // profile once, budgeted per tick, so a replier who IS in Twenty can actually be found. Members already in
      // the map were turned into a vanity link by prospectOf, so they skip this.
      if ((!profileUrl || OBFUSCATED_URL.test(profileUrl)) && resolved < RESOLVE_PER_TICK && !tried.has(memberUrn)) {
        tried.add(memberUrn);
        resolved++;
        profileUrl = (await resolveVanityUrl(c.accountId, memberUrn)) ?? profileUrl;
      }
      if (!linkedinKey(profileUrl)) {
        await needsBinding(c, 'No LinkedIn profile link known yet');
        continue;
      }
      const people = await peopleWithLinkedin(profileUrl as string);
      if (people.length === 1) {
        // Auto-bind to the one matching Person — unless auto-bind is off, in which case a matching replier waits for a
        // teammate to bind them by hand (binding to existing People is then fully manual).
        if (config.crmAutoBind) {
          await bindProspect(memberUrn, people[0], 'auto_link', null);
          bound++;
        } else {
          await needsBinding(c, 'In Twenty — bind them by hand');
        }
        continue;
      }
      // Exact link didn't give exactly one match. Auto-bind to a fuzzy match only when auto-bind AND fuzzy are both on:
      // score candidates (by link + name) and auto-bind a clear winner (score ≥ threshold, beating the runner-up by the
      // margin); below that, show the ranked options. A weak signal (shared name prefix) scores far under the threshold so
      // it can only be an option, never auto-bound. A wrong fuzzy bind is reversible (admin unbind) and audited with its
      // score. Also catches a case-mismatched exact link the strict lookup missed (searchPeople is case-insensitive).
      if (config.crmAutoBind && config.crmFuzzyBind) {
        const cands = (await searchPeople(prospect.name, profileUrl, null)).map((p) => ({
          id: p.id,
          name: p.name,
          linkedin: p.linkedin,
          jobTitle: p.jobTitle,
          company: p.company,
        }));
        const d = decide(rankCandidates({ name: prospect.name, profileUrl, headline: prospect.headline }, cands), {
          threshold: MATCH_THRESHOLD,
          margin: MATCH_MARGIN,
        });
        if (d.action === 'auto' && d.top) {
          await bindProspect(memberUrn, d.top.id, d.top.score >= 100 ? 'auto_link' : 'auto_score', null, undefined, {
            score: d.top.score,
            reason: d.top.reason,
          });
          bound++;
          continue;
        }
        if (d.action === 'options') {
          await needsBinding(c, `${d.options.length} possible match${d.options.length === 1 ? '' : 'es'} in Twenty — choose one`);
          continue;
        }
      }
      if (people.length === 0) {
        // Nobody in Twenty has their link. With auto-create on, make a Person for them and bind (owner-less, since no
        // teammate chose it); we just confirmed zero match, so this can't duplicate an existing Person. Only from a real
        // resolved vanity link — never an obfuscated member-URN URL (/in/ACoA…), whose mixed case defeats the link lookup.
        const canCreate = config.crmAutoCreate && !OBFUSCATED_URL.test(profileUrl as string);
        if (!canCreate) {
          await needsBinding(c, 'Not in Twenty yet (no Person has this LinkedIn profile)');
        } else if (recentCreates + createsThisRun >= CREATE_CAP_PER_HOUR) {
          // Hourly cap reached: pause auto-create and alert instead of creating more (runaway guard).
          await tripCreateBreaker(recentCreates + createsThisRun);
          await needsBinding(c, 'Auto-create paused: hourly safety limit reached');
        } else {
          // Idempotency guard: a Person we created earlier (same LinkedIn member id) may exist even though the link
          // lookup missed it — bind to that one instead of making a duplicate. This is what stops a create→retry loop.
          // Only when the workspace has the member-id field (that's where the id is stored); otherwise skip the lookup.
          const prior = (await personHasField('linkedinMemberId')) ? await personByLinkedinMemberId(memberIdOf(memberUrn)) : null;
          if (prior) {
            await bindProspect(memberUrn, prior, 'auto_link', null);
          } else {
            const personId = await createProspectPerson(prospect, memberUrn, { memberId: null, pod: null });
            await bindProspect(memberUrn, personId, 'auto_new', null);
            createsThisRun++;
          }
          bound++;
        }
      } else {
        await needsBinding(c, `${people.length} Persons in Twenty have this LinkedIn profile`);
      }
    } catch (err) {
      // Twenty busy or down (e.g. a 504 from one request): stop this tick and let the next one resume from here,
      // instead of one transient error aborting the whole round.
      if (/answered (429|5\d\d)|timeout|fetch failed/i.test((err as Error).message)) break;
      // Any other error binding this prospect: log it AND put it on the "needed" cooldown rather than leaving it to be
      // retried (and possibly re-created) on every tick — a repeatedly failing bind must not loop, which is what turned
      // the auto_new constraint failure into thousands of duplicates.
      logger.warn({ err, conversationId: c.id }, 'binding a replied prospect failed');
      await needsBinding(c, 'Binding failed; will retry later').catch(() => {});
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

// ---------- A teammate's decision (Needs CRM binding) ----------

/** Which owner / pod / console fields this Twenty workspace has (only those are written). */
export async function crmFields() {
  const t = config.twenty;
  if (!t) throw new HttpError(409, 'Twenty CRM is not configured');
  const [ownerType, podType, source, memberId] = await Promise.all([
    personFieldType(t.ownerField),
    personFieldType(t.podField),
    personHasField('linkedinConsoleSource'),
    personHasField('linkedinMemberId'),
  ]);
  return {
    // The owner is a link to a workspace member; anything else isn't an owner we can set.
    owner: ownerType === 'RELATION' ? t.ownerField : null,
    pod: podType ? t.podField : null,
    source,
    memberId,
  };
}

/** LinkedIn's member id from its URN (urn:li:fsd_profile:ACoAA… → ACoAA…). */
const memberIdOf = (urn: string) => urn.split(':').pop() ?? urn;

async function teammate(userId: string) {
  const [u] = await sql`SELECT twenty_member_id, pod FROM users WHERE id = ${userId}`;
  return { memberId: (u?.twentyMemberId as string | null) ?? null, pod: (u?.pod as string | null) ?? null };
}

/** The 1:1 conversation's prospect, ready for a decision (bound ones and group chats can't be). */
async function decidable(conversationId: string) {
  const [c] = await sql`SELECT id, account_id, participants, is_group, crm_binding FROM conversations WHERE id = ${conversationId}`;
  if (!c || c.isGroup) throw new HttpError(400, 'Only a 1:1 conversation can be bound to a Twenty Person');
  if (c.crmBinding === 'bound') throw new HttpError(409, 'This prospect is already bound to a Twenty Person');
  const prospect = await prospectOf(c.accountId, c.participants ?? []);
  if (!prospect.memberUrn) throw new HttpError(409, 'LinkedIn has not identified this prospect yet; try again after the next sync');
  return { conversation: c, prospect, memberUrn: prospect.memberUrn };
}

/**
 * Binds to a Person a teammate chose. Fills the Person's owner and pod (the teammate's), LinkedIn link and member
 * id only where empty: an existing owner is never overwritten.
 */
export async function bindToExisting(conversationId: string, personId: string, by: { id: string }, ip?: string) {
  const { prospect, memberUrn } = await decidable(conversationId);
  const fields = await crmFields();
  const person = await personById(personId, { ownerField: fields.owner, podField: fields.pod });
  if (!person) throw new HttpError(404, 'That Person no longer exists in Twenty');
  const me = await teammate(by.id);
  const fill: Record<string, unknown> = {};
  if (fields.owner && !person.ownerId && me.memberId) fill[`${fields.owner}Id`] = me.memberId;
  if (fields.pod && !person.pod && me.pod) fill[fields.pod] = me.pod;
  if (!person.linkedin && prospect.profileUrl) fill.linkedinLink = { primaryLinkUrl: prospect.profileUrl, primaryLinkLabel: 'LinkedIn' };
  if (fields.memberId) fill.linkedinMemberId = memberIdOf(memberUrn);
  if (Object.keys(fill).length) await updatePerson(personId, fill);
  await bindProspect(memberUrn, personId, 'existing', by, ip);
  return { personId, filled: Object.keys(fill) };
}

/**
 * Creates a new Twenty Person for a prospect and returns its id. Owner and pod are set only when known (a teammate
 * linked to a Twenty member); an auto-created Person, or one added by someone not linked to Twenty, simply has no
 * owner until a teammate takes it — the Person is created either way, never blocked. Writes the LinkedIn link, member
 * id and the "LinkedIn Console" source where those fields exist. The caller must have already checked that no Person
 * has this LinkedIn link, so this never makes a duplicate.
 */
async function createProspectPerson(
  prospect: { name: string; profileUrl: string | null; headline: string | null },
  memberUrn: string,
  owner: { memberId: string | null; pod: string | null },
): Promise<string> {
  const fields = await crmFields();
  return createPerson({
    name: prospect.name,
    profileUrl: prospect.profileUrl,
    headline: prospect.headline,
    extra: {
      ...(fields.owner && owner.memberId ? { [`${fields.owner}Id`]: owner.memberId } : {}),
      ...(fields.pod && owner.pod ? { [fields.pod]: owner.pod } : {}),
      ...(fields.source ? { linkedinConsoleSource: CONSOLE_SOURCE.ADDED } : {}),
      ...(fields.memberId ? { linkedinMemberId: memberIdOf(memberUrn) } : {}),
    },
  });
}

/**
 * Adds the prospect as a new Person, owned by the teammate and in their pod when they are linked to a Twenty member
 * (otherwise owner-less — never blocked). Refused when any Person already has their LinkedIn link (bind to that one
 * instead), so even this can't create a duplicate.
 */
export async function addAsNew(conversationId: string, by: { id: string }, ip?: string) {
  const { prospect, memberUrn } = await decidable(conversationId);
  if (prospect.profileUrl && (await peopleWithLinkedin(prospect.profileUrl)).length) {
    throw new HttpError(409, 'A Person in Twenty already has this LinkedIn profile: bind to that one instead');
  }
  const me = await teammate(by.id);
  const personId = await createProspectPerson(prospect, memberUrn, me);
  await bindProspect(memberUrn, personId, 'new', by, ip);
  return { personId };
}

/** An admin undoes a binding (wrong Person). The prospect then waits for a teammate; never bound again by itself. */
export async function unbindByAdmin(conversationId: string, by: { id: string; name: string }, ip?: string) {
  const [c] = await sql`SELECT participants, crm_binding, twenty_person_id FROM conversations WHERE id = ${conversationId}`;
  if (!c || c.crmBinding !== 'bound') throw new HttpError(409, 'This prospect is not bound');
  const memberUrn = c.participants?.[0]?.urn as string;
  await sql`DELETE FROM crm_bindings WHERE member_urn = ${memberUrn}`;
  const convs = await sql<{ id: string; accountId: string }[]>`
    UPDATE conversations SET twenty_person_id = NULL, crm_binding = 'needed', crm_nudged_at = NULL,
      crm_binding_reason = ${`Unbound by ${by.name}: bind it again by hand`},
      -- Never looked at again automatically (the link match was the wrong Person).
      crm_binding_at = 'infinity'
    WHERE participants->0->>'urn' = ${memberUrn} AND NOT is_group
    RETURNING id, account_id`;
  await audit({
    userId: by.id,
    accountId: convs[0]?.accountId,
    action: 'crm.unbound',
    meta: { memberUrn, personId: c.twentyPersonId },
    ip,
  });
  await changed(convs);
}

/**
 * An admin undoes a binding AND deletes the prospect from Twenty: removes their Person and every LinkedIn-conversation
 * record linked to it from Twenty, then does the local unbind. Deliberate, confirm-first, audited — NEVER automatic
 * (the normal unbind stays local-only). If Twenty refuses or the Person is already gone, the local unbind still
 * happens and the result says what reached Twenty, so a stuck CRM can never block cleaning up the console.
 */
export async function unbindAndDeleteByAdmin(conversationId: string, by: { id: string; name: string }, ip?: string) {
  const [c] = await sql`SELECT participants, crm_binding, twenty_person_id FROM conversations WHERE id = ${conversationId}`;
  if (!c || c.crmBinding !== 'bound') throw new HttpError(409, 'This prospect is not bound');
  const memberUrn = c.participants?.[0]?.urn as string;
  const personId = c.twentyPersonId as string | null;

  let recordsDeleted = 0;
  let personDeleted = false;
  let twentyError: string | null = null;
  if (personId) {
    try {
      // Records first, then the Person: a prospect's conversation records don't linger after their Person is gone.
      recordsDeleted = await deleteConversationRecordsForPerson(personId);
      personDeleted = await deletePersonInTwenty(personId);
    } catch (err) {
      // Twenty busy, offline or refusing: unbind locally anyway and report what happened (never leave it half-done).
      twentyError = (err as Error).message;
      logger.warn({ err, personId, conversationId }, 'deleting the prospect from Twenty failed; unbinding locally anyway');
    }
  }

  await sql`DELETE FROM crm_bindings WHERE member_urn = ${memberUrn}`;
  const convs = await sql<{ id: string; accountId: string }[]>`
    UPDATE conversations SET twenty_person_id = NULL, crm_binding = 'needed', crm_nudged_at = NULL,
      -- The Twenty records are gone: forget them so a later rebind creates fresh ones instead of updating dead ids.
      twenty_record_id = NULL, twenty_record_hash = NULL, twenty_record_checked_at = NULL,
      crm_binding_reason = ${`Unbound and deleted from Twenty by ${by.name}: bind it again by hand`},
      -- Never looked at again automatically (the Person was deleted on purpose).
      crm_binding_at = 'infinity'
    WHERE participants->0->>'urn' = ${memberUrn} AND NOT is_group
    RETURNING id, account_id`;
  await audit({
    userId: by.id,
    accountId: convs[0]?.accountId,
    action: 'crm.deleted_in_twenty',
    meta: { memberUrn, personId, personDeleted, recordsDeleted, twentyError },
    ip,
  });
  await changed(convs);
  return { personId, personDeleted, recordsDeleted, twentyError };
}

/** Replies waiting more than a business day for a binding: the teammate responsible is reminded, once. */
export async function nudgeUnbound(now = new Date()) {
  const waiting = await sql`
    SELECT c.id, c.account_id, c.crm_binding_at, a.timezone, ${RESPONSIBLE} AS responsible,
           coalesce(c.title, c.participants->0->>'name', 'a prospect') AS prospect
    FROM conversations c JOIN accounts a ON a.id = c.account_id
    WHERE c.crm_binding = 'needed' AND c.crm_nudged_at IS NULL AND c.crm_binding_at < ${now}::timestamptz - interval '1 day'
    LIMIT 100`;
  let nudged = 0;
  for (const c of waiting) {
    const since = c.crmBindingAt as Date;
    // One business day in the account's timezone (a reply on Friday is nudged on Monday).
    if (addBusinessDays(since, 1, c.timezone, 0) > now) continue;
    let to: string[] = c.responsible ? [c.responsible] : [];
    if (!to.length) {
      const rows = await sql`
        SELECT u.id FROM users u LEFT JOIN account_grants g ON g.user_id = u.id AND g.account_id = ${c.accountId}
        WHERE u.disabled_at IS NULL AND (u.role IN ('OWNER', 'ADMIN') OR g.level IN ('REPLY', 'FULL'))`;
      to = rows.map((u) => u.id as string);
    }
    await pushToUsers(to, {
      title: `Bind ${c.prospect} to Twenty`,
      body: 'They replied and are not in Twenty yet: bind them to a Person or add them as new.',
      url: `/inbox/${c.id}`,
      tag: `crm-${c.id}`,
    }).catch(() => {});
    await sql`UPDATE conversations SET crm_nudged_at = now() WHERE id = ${c.id}`;
    nudged++;
  }
  return nudged;
}
