// Twenty CRM sync (CRM_SYNC=on), duplicates prevented rather than merged (master plan, 16 Oct):
//  - a prospect reaches Twenty only after they reply and are bound to exactly one Person (crm-binding.ts):
//    automatically on an exact LinkedIn profile-link match, otherwise by a teammate; never by name, never created
//    by the sync itself;
//  - once bound, every message from the moment the sync was switched on is a note on that Person (also the ones
//    sent before the reply): who sent it, through which LinkedIn account;
//  - Persons the earlier sync created for prospects who never replied are marked for review (nothing deleted).
// History (first syncs, archive imports) is not copied. A few messages at a time, in order, retried with a growing
// pause when Twenty fails; a Person deleted or merged in Twenty unbinds the prospect, who is then looked at again.
import { config } from '../lib/config.ts';
import { getSetting, sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { redis } from '../lib/redis.ts';
import { addPersonNote, PersonGoneError } from '../lib/twenty.ts';
import { bindReplied, markForReview, prospectOf, unbindProspect } from './crm-binding.ts';
import { syncConversationRecords, syncPersonFields } from './crm-fields.ts';

const BATCH = 5; // per tick (every 10 s): ~30 messages a minute, well inside Twenty's API limits
const MAX_ATTEMPTS = 6;
const STATUS_KEY = 'lu:crmsync:status';
const SINCE_KEY = 'crm_sync_since';

export interface CrmSyncStatus {
  at: string;
  ok: boolean;
  synced: number;
  /** Prospects bound automatically in this run. */
  bound?: number;
  error?: string;
}

/** When the sync was first switched on: only messages from then on go to Twenty. */
export async function crmSince(): Promise<Date> {
  const saved = await getSetting<string>(SINCE_KEY);
  if (saved) return new Date(saved);
  const now = new Date().toISOString();
  await sql`INSERT INTO settings (key, value) VALUES (${SINCE_KEY}, ${sql.json(now as never)}) ON CONFLICT (key) DO NOTHING`;
  return new Date((await getSetting<string>(SINCE_KEY)) ?? now);
}

const when = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16);

export { prospectOf } from './crm-binding.ts';

export async function crmSyncTick(): Promise<CrmSyncStatus | null> {
  if (!config.crmSync) return null;
  if (!(await redis.set('lu:crmsync:lock', '1', 'EX', 120, 'NX'))) return null;
  const status: CrmSyncStatus = { at: new Date().toISOString(), ok: true, synced: 0 };
  try {
    const since = await crmSince();
    status.bound = await bindReplied();
    await markForReview();
    // The LinkedIn summary on bound Persons and their LinkedIn conversation records (only what changed).
    await syncPersonFields();
    await syncConversationRecords();
    // Never going to Twenty: group chats, deleted or failed messages, and history older than the switch-on.
    await sql`
      UPDATE messages m SET crm_synced_at = now()
      FROM conversations c
      WHERE c.id = m.conversation_id AND m.crm_synced_at IS NULL AND m.created_at >= ${since}
        AND (c.is_group OR m.deleted OR m.status = 'FAILED' OR m.sent_at < ${since}::timestamptz - interval '1 day')`;
    const due = await sql`
      SELECT m.id, m.conversation_id, m.account_id, m.direction, m.text, m.attachments, m.sent_at, m.crm_attempts,
             u.name AS staff_name, c.participants, c.twenty_person_id, a.label AS account_label
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN accounts a ON a.id = m.account_id
      LEFT JOIN users u ON u.id = m.sent_by_user_id
      WHERE m.crm_synced_at IS NULL AND m.created_at >= ${since} AND m.crm_attempts < ${MAX_ATTEMPTS}
        AND (m.crm_next_at IS NULL OR m.crm_next_at <= now())
        AND (m.direction = 'INBOUND' OR m.status = 'SENT')
        -- Only prospects bound to a Person; the others wait (nothing is lost) until they are.
        AND c.crm_binding = 'bound' AND c.twenty_person_id IS NOT NULL
      ORDER BY m.created_at LIMIT ${BATCH}`;

    for (const m of due) {
      try {
        const prospect = await prospectOf(m.accountId, m.participants ?? []);
        // Re-read: an earlier message of this batch may have unbound the prospect (Person gone).
        const [c] = await sql`SELECT twenty_person_id FROM conversations WHERE id = ${m.conversationId} AND crm_binding = 'bound'`;
        const personId = c?.twentyPersonId as string | undefined;
        if (!personId) continue;
        const inbound = m.direction === 'INBOUND';
        const files = (m.attachments as unknown[] | null)?.length ?? 0;
        const text = (m.text as string | null)?.trim() || (files ? `📎 ${files} attachment${files === 1 ? '' : 's'}` : '(no text)');
        const title = inbound ? `LinkedIn: ${prospect.name} replied` : `LinkedIn: message to ${prospect.name}`;
        const by = inbound ? `From ${prospect.name}` : `Sent by ${m.staffName ?? 'the account owner on LinkedIn'}`;
        const link = config.appUrl ? `\n\nOpen in LinkedIn Console: ${config.appUrl}/inbox/${m.conversationId}` : '';
        const body = `${text}\n\n${by} · LinkedIn account ${m.accountLabel} · ${when(m.sentAt)} UTC${link}`;
        const noteId = await addPersonNote(personId as string, title, body);
        await sql`
          UPDATE messages SET crm_note_id = ${noteId}, crm_synced_at = now(), crm_error = NULL, crm_next_at = NULL
          WHERE id = ${m.id}`;
        status.synced++;
      } catch (err) {
        const message = (err as Error).message.slice(0, 500);
        const gone = err instanceof PersonGoneError;
        // Deleted or merged in Twenty: the prospect is looked at again (auto-bind by link, or a teammate decides).
        const memberUrn = (m.participants?.[0]?.urn as string | undefined) ?? '';
        if (gone && memberUrn) await unbindProspect(memberUrn, 'The Person was deleted or merged in Twenty');
        const pauseMin = gone ? 0 : 2 ** m.crmAttempts;
        await sql`
          UPDATE messages SET crm_attempts = crm_attempts + 1, crm_error = ${message},
            crm_next_at = now() + make_interval(mins => ${pauseMin})
          WHERE id = ${m.id}`;
        Object.assign(status, { ok: false, error: message });
        if (/answered (429|5\d\d)/.test(message)) break; // Twenty is busy or down: wait for the next tick
      }
    }
  } catch (err) {
    Object.assign(status, { ok: false, error: (err as Error).message });
    logger.error({ err }, 'crm sync failed');
  } finally {
    await redis.del('lu:crmsync:lock');
  }
  if (status.synced || status.bound || !status.ok) await redis.set(STATUS_KEY, JSON.stringify(status));
  return status;
}

/** For the Team page: is it on, how far along, what went wrong last. */
export async function crmSyncStatus() {
  if (!config.crmSync) return { enabled: false as const };
  const since = await crmSince();
  const [counts] = await sql`
    SELECT count(*) FILTER (WHERE crm_synced_at IS NULL AND crm_attempts < ${MAX_ATTEMPTS})::int AS pending,
           count(*) FILTER (WHERE crm_synced_at IS NULL AND crm_attempts >= ${MAX_ATTEMPTS})::int AS failed,
           count(*) FILTER (WHERE crm_note_id IS NOT NULL AND crm_synced_at > now() - interval '24 hours')::int AS synced_24h
    FROM messages m WHERE m.created_at >= ${since} AND (m.crm_synced_at IS NULL OR m.crm_synced_at > now() - interval '24 hours')
      -- Waiting for a binding is not "pending": counted below.
      AND (m.crm_synced_at IS NOT NULL OR EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id AND c.crm_binding = 'bound'))`;
  const [people] = await sql`SELECT count(*)::int AS n FROM crm_bindings`;
  const [binding] = await sql`
    SELECT count(*) FILTER (WHERE crm_binding = 'needed')::int AS needed,
           count(*) FILTER (WHERE crm_review_person_id IS NOT NULL AND crm_review_marked_at IS NULL)::int AS review_pending,
           count(DISTINCT crm_review_person_id) FILTER (WHERE crm_review_marked_at IS NOT NULL)::int AS reviewed
    FROM conversations WHERE NOT is_group`;
  const raw = await redis.get(STATUS_KEY);
  return {
    enabled: true as const,
    since: since.toISOString(),
    pending: counts.pending as number,
    failed: counts.failed as number,
    synced24h: counts.synced24h as number,
    people: people.n as number,
    /** Replied, waiting for a teammate to bind them (or for profile data). */
    needsBinding: binding.needed as number,
    /** Persons from the earlier sync (no reply) still to mark for review / marked. */
    reviewPending: binding.reviewPending as number,
    reviewed: binding.reviewed as number,
    last: raw ? (JSON.parse(raw) as CrmSyncStatus) : null,
  };
}

/** Gives the messages that failed for good another round (Team page → Retry). */
export async function retryFailedCrm() {
  const since = await crmSince();
  const r = await sql`
    UPDATE messages SET crm_attempts = 0, crm_next_at = NULL
    WHERE crm_synced_at IS NULL AND crm_attempts >= ${MAX_ATTEMPTS} AND created_at >= ${since}`;
  return r.count;
}
