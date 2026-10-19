// LinkedIn data in Twenty fields (CRM_SYNC=on), for bound prospects only:
//  - their Person: the LinkedIn summary over every conversation with them (status, last sent / received, reply
//    status, next follow-up, member ID, link to their latest conversation);
//  - one "LinkedIn conversation" record per conversation (prospect × LinkedIn account), linked to the Person.
// Only fields and the object that exist in the workspace are written (scripts/twenty-fields.sh adds them), and only
// when something changed: a hash of what was last written is kept. Looked at again on new activity (messages,
// reminders, connection data) and at least hourly. A Person gone from Twenty unbinds the prospect.
import crypto from 'node:crypto';
import { RESPONSIBLE } from '../core/reminders-sql.ts';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { createRecord, updatePerson, updateRecord } from '../lib/twenty.ts';
import {
  CONVERSATION_OBJECT,
  conversationObjectFields,
  LINKEDIN_STATUS,
  PERSON_FIELDS,
  personHasField,
  REPLY_STATUS,
} from '../lib/twenty-fields.ts';
import { unbindProspect } from './crm-binding.ts';

const BATCH = 20;
/** Twenty busy or down: stop this round (the next tick tries again). */
const busy = (err: unknown) => /answered (429|5\d\d)|timeout|fetch failed/i.test((err as Error).message);
const hash = (v: unknown) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('base64url');
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const conversationUrl = (id: string | null) => (id && config.appUrl ? `${config.appUrl}/inbox/${id}` : null);
const link = (url: string | null) => (url ? { primaryLinkUrl: url, primaryLinkLabel: 'Open in LinkedIn Console' } : null);
const memberIdOf = (urn: string) => urn.split(':').pop() ?? urn;

/** Only the fields this workspace has. */
async function present(values: Record<string, unknown>, has: (name: string) => Promise<boolean> | boolean) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) if (await has(k)) out[k] = v;
  return out;
}

/** "Something happened since we last looked" for the conversations with a prospect (SQL, alias c). */
const activitySince = (checked: ReturnType<typeof sql>) => sql`(
  EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.created_at > ${checked})
  OR EXISTS (SELECT 1 FROM reminders r WHERE r.conversation_id = c.id AND r.updated_at > ${checked}))`;

/** The prospect's LinkedIn summary on their Person. */
export async function syncPersonFields(limit = BATCH) {
  // None of the fields exist yet: look at nobody (once they're added, everyone is written, nobody waits an hour).
  const usable = await Promise.all(PERSON_FIELDS.filter((f) => f.name !== 'linkedinConsoleSource').map((f) => personHasField(f.name)));
  if (!usable.some(Boolean)) return 0;
  const due = await sql`
    SELECT b.member_urn, b.person_id, b.fields_hash FROM crm_bindings b
    WHERE b.fields_checked_at IS NULL OR b.fields_checked_at < now() - interval '1 hour'
       OR EXISTS (SELECT 1 FROM conversations c WHERE c.participants->0->>'urn' = b.member_urn AND NOT c.is_group
                  AND ${activitySince(sql`b.fields_checked_at`)})
       OR EXISTS (SELECT 1 FROM contacts ct WHERE ct.member_urn = b.member_urn AND ct.updated_at > b.fields_checked_at)
    ORDER BY b.fields_checked_at NULLS FIRST LIMIT ${limit}`;
  let written = 0;
  for (const b of due) {
    try {
      const [s] = await sql`
      SELECT
        (SELECT max(m.sent_at) FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.participants->0->>'urn' = ${b.memberUrn} AND NOT c.is_group AND m.direction = 'OUTBOUND' AND m.status = 'SENT') AS last_sent,
        (SELECT max(m.sent_at) FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.participants->0->>'urn' = ${b.memberUrn} AND NOT c.is_group AND m.direction = 'INBOUND') AS last_received,
        (SELECT min(r.due_at) FROM reminders r JOIN conversations c ON c.id = r.conversation_id
          WHERE r.status = 'OPEN' AND c.participants->0->>'urn' = ${b.memberUrn}) AS next_follow_up,
        (SELECT c.id FROM conversations c WHERE c.participants->0->>'urn' = ${b.memberUrn} AND NOT c.is_group
          ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1) AS latest`;
      const lastSent = s.lastSent as Date | null;
      const lastReceived = s.lastReceived as Date | null;
      const values = await present(
        {
          // A Person reaches Twenty only after a reply, and the console only messages existing connections, so a
          // bound prospect is Connected (master plan L3). Not derived from the connection list, which is
          // incomplete on large accounts and would wrongly show "Not connected". (REQUEST_SENT is out of scope.)
          linkedinStatus: LINKEDIN_STATUS.CONNECTED,
          lastLinkedinMessageSentAt: iso(lastSent),
          lastLinkedinMessageReceivedAt: iso(lastReceived),
          linkedinReplyStatus: lastReceived && (!lastSent || lastReceived > lastSent) ? REPLY_STATUS.REPLIED : REPLY_STATUS.NO_REPLY,
          nextLinkedinFollowUpAt: iso(s.nextFollowUp),
          linkedinMemberId: memberIdOf(b.memberUrn),
          linkedinConversation: link(conversationUrl(s.latest)),
        },
        (name) => PERSON_FIELDS.some((f) => f.name === name) && personHasField(name),
      );
      const h = hash(values);
      if (Object.keys(values).length && h !== b.fieldsHash) {
        if (!(await updatePerson(b.personId, values))) {
          await unbindProspect(b.memberUrn, 'The Person was deleted or merged in Twenty');
          continue;
        }
        written++;
      }
      await sql`UPDATE crm_bindings SET fields_hash = ${h}, fields_checked_at = now() WHERE member_urn = ${b.memberUrn}`;
    } catch (err) {
      if (busy(err)) throw err;
      // Rejected by Twenty (e.g. a field of another type): looked at again within the hour, the rest go on.
      await sql`UPDATE crm_bindings SET fields_checked_at = now() WHERE member_urn = ${b.memberUrn}`;
      logger.warn({ err, memberUrn: b.memberUrn }, 'twenty person fields rejected');
    }
  }
  return written;
}

/** One LinkedIn conversation record per bound conversation, linked to the Person. */
export async function syncConversationRecords(limit = BATCH) {
  const fields = await conversationObjectFields();
  if (!fields) return 0; // the object isn't there yet (scripts/twenty-fields.sh)
  const due = await sql`
    SELECT c.id, c.twenty_person_id, c.twenty_record_id, c.twenty_record_hash, c.participants, a.label AS account_label,
           (SELECT max(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'OUTBOUND' AND m.status = 'SENT') AS last_sent,
           (SELECT max(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'INBOUND') AS last_received,
           (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND NOT m.deleted) AS messages,
           (SELECT r.due_at FROM reminders r WHERE r.conversation_id = c.id AND r.status = 'OPEN') AS next_follow_up,
           (SELECT u.name FROM users u WHERE u.id = ${RESPONSIBLE}) AS handled_by
    FROM conversations c JOIN accounts a ON a.id = c.account_id
    WHERE c.crm_binding = 'bound' AND c.twenty_person_id IS NOT NULL AND NOT c.is_group
      AND (c.twenty_record_checked_at IS NULL OR c.twenty_record_checked_at < now() - interval '1 hour'
           OR ${activitySince(sql`c.twenty_record_checked_at`)})
    ORDER BY c.twenty_record_checked_at NULLS FIRST LIMIT ${limit}`;
  let written = 0;
  for (const c of due) {
    try {
      const lastSent = c.lastSent as Date | null;
      const lastReceived = c.lastReceived as Date | null;
      const prospect = (c.participants?.[0]?.name as string | undefined) ?? 'LinkedIn Member';
      const values = await present(
        {
          name: `${prospect} · ${c.accountLabel}`,
          personId: c.twentyPersonId,
          linkedinAccount: c.accountLabel,
          handledBy: c.handledBy ?? null,
          replyStatus: lastReceived && (!lastSent || lastReceived > lastSent) ? REPLY_STATUS.REPLIED : REPLY_STATUS.NO_REPLY,
          lastMessageSentAt: iso(lastSent),
          lastMessageReceivedAt: iso(lastReceived),
          nextFollowUpAt: iso(c.nextFollowUp),
          messageCount: c.messages,
          conversationLink: link(conversationUrl(c.id)),
        },
        // personId is the relation "person"; the rest by their own names.
        (name) => fields.has(name === 'personId' ? CONVERSATION_OBJECT.relation.name : name),
      );
      const h = hash(values);
      let recordId = c.twentyRecordId as string | null;
      if (h !== c.twentyRecordHash || !recordId) {
        const updated = recordId && (await updateRecord(CONVERSATION_OBJECT.nameSingular, recordId, values));
        if (!updated) recordId = await createRecord(CONVERSATION_OBJECT.nameSingular, values); // new, or deleted in Twenty
        written++;
      }
      await sql`
      UPDATE conversations SET twenty_record_id = ${recordId}, twenty_record_hash = ${h}, twenty_record_checked_at = now()
      WHERE id = ${c.id}`;
    } catch (err) {
      if (busy(err)) throw err;
      await sql`UPDATE conversations SET twenty_record_checked_at = now() WHERE id = ${c.id}`;
      logger.warn({ err, conversationId: c.id }, 'twenty conversation record rejected');
    }
  }
  return written;
}
