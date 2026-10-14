// Automatic follow-ups. When our message is the last one in a 1:1 conversation and the prospect stays silent for
// the account's number of business days (Accounts → settings; weekends don't count), a reminder is created for
// the teammate responsible, due at 9:00 local time of the account on that business day (it then notifies like
// any reminder, and becomes a Twenty task with the CRM sync). Nothing is created on a weekend.
// Not created when the prospect already has a reminder for this silence (open, or set or closed since our last
// message), or was marked "Close prospect" and hasn't written since. When they reply, an open automatic
// reminder closes itself.
import { accountRoom } from '@linkedin-console/contracts';
import { audit } from '../core/audit.ts';
import { closeReminder } from '../core/reminders.ts';
import { addBusinessDays, isWeekend } from '../lib/business-days.ts';
import { sql } from '../lib/db.ts';
import { newId } from '../lib/ids.ts';
import { publish, redis } from '../lib/redis.ts';
import { loadConversation } from '../modules/conversations/queries.ts';

/** How far back a silence still gets a follow-up (beyond the account's days), so switching on doesn't flood. */
const BACKLOG_DAYS = 14;

export async function autoFollowups(now = new Date()) {
  if (!(await redis.set('lu:autofollowups:lock', '1', 'EX', 240, 'NX'))) return { created: 0, closed: 0 };
  try {
    // The prospect answered an automatic follow-up's silence: it is no longer needed.
    const answered = await sql`
      SELECT r.id FROM reminders r
      WHERE r.status = 'OPEN' AND r.source = 'auto' AND EXISTS (
        SELECT 1 FROM messages m WHERE m.conversation_id = r.conversation_id AND m.direction = 'INBOUND' AND m.sent_at > r.trigger_at)`;
    for (const r of answered) await closeReminder({ reminderId: r.id }, 'DONE', null, undefined, 'auto');

    const silent = await sql`
      SELECT c.id, c.account_id, c.last_message_at, a.timezone, a.followup_days
      FROM conversations c JOIN accounts a ON a.id = c.account_id
      WHERE a.followup_days > 0 AND NOT c.is_group AND NOT c.is_archived AND c.folder NOT IN ('archived', 'spam')
        AND c.last_message_from_self
        -- Business days are at least as many calendar days: a cheap first cut, the exact date is worked out below.
        AND c.last_message_at <= ${now}::timestamptz - make_interval(days => a.followup_days)
        AND c.last_message_at >= ${now}::timestamptz - make_interval(days => a.followup_days * 2 + ${BACKLOG_DAYS})
        AND NOT EXISTS (
          SELECT 1 FROM reminders r WHERE r.conversation_id = c.id AND (r.status = 'OPEN' OR r.created_at >= c.last_message_at))
        AND NOT EXISTS (
          SELECT 1 FROM reminders r WHERE r.conversation_id = c.id AND r.status = 'CLOSED'
            AND r.closed_at > coalesce((SELECT max(m.sent_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'INBOUND'), '-infinity'))
      ORDER BY c.last_message_at LIMIT 200`;

    let created = 0;
    for (const c of silent) {
      if (isWeekend(now, c.timezone)) continue;
      const dueAt = addBusinessDays(c.lastMessageAt, c.followupDays, c.timezone);
      if (dueAt > now) continue;
      const days = c.followupDays as number;
      const [r] = await sql`
        INSERT INTO reminders (id, conversation_id, account_id, due_at, note, source, trigger_at)
        VALUES (${newId('rem')}, ${c.id}, ${c.accountId}, ${dueAt},
                ${`No reply for ${days} business day${days === 1 ? '' : 's'} since our last message`}, 'auto', ${c.lastMessageAt})
        ON CONFLICT (conversation_id) WHERE status = 'OPEN' DO NOTHING
        RETURNING id`;
      if (!r) continue;
      created++;
      await audit({
        accountId: c.accountId,
        action: 'reminder.set',
        meta: { conversationId: c.id, dueAt: dueAt.toISOString(), auto: true },
      });
      await publish(accountRoom(c.accountId), 'conversation.updated', await loadConversation(c.id));
    }
    return { created, closed: answered.length };
  } finally {
    await redis.del('lu:autofollowups:lock');
  }
}
