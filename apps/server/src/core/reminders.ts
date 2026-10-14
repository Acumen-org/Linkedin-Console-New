// Follow-up reminders: one open per prospect (conversation), with a date and an optional note. Who it is for
// follows the conversation: its assignee, else the last teammate who messaged them, else everyone working the
// account. Closed as Done (followed up) or Closed (stop following this prospect), here or in Twenty.
import { accountRoom, type ReminderStatus } from '@linkedin-console/contracts';
import { sql } from '../lib/db.ts';
import { newId } from '../lib/ids.ts';
import { publish } from '../lib/redis.ts';
import { loadConversation } from '../modules/conversations/queries.ts';
import { audit } from './audit.ts';

export { RESPONSIBLE } from './reminders-sql.ts';

async function changed(accountId: string, conversationId: string) {
  await publish(accountRoom(accountId), 'conversation.updated', await loadConversation(conversationId));
}

/** Sets the prospect's reminder (a new one, or moves the open one). A moved reminder notifies again. */
export async function setReminder(
  conversation: { id: string; accountId: string },
  input: { dueAt: Date; note: string | null },
  by: { id: string },
  ip?: string,
) {
  const [r] = await sql`
    INSERT INTO reminders (id, conversation_id, account_id, due_at, note, created_by)
    VALUES (${newId('rem')}, ${conversation.id}, ${conversation.accountId}, ${input.dueAt}, ${input.note}, ${by.id})
    ON CONFLICT (conversation_id) WHERE status = 'OPEN' DO UPDATE SET
      due_at = excluded.due_at, note = excluded.note, updated_at = now(),
      notified_at = CASE WHEN reminders.due_at = excluded.due_at THEN reminders.notified_at END
    RETURNING id, (xmax = 0) AS created`;
  await audit({
    userId: by.id,
    accountId: conversation.accountId,
    action: 'reminder.set',
    meta: { conversationId: conversation.id, dueAt: input.dueAt.toISOString(), created: r.created },
    ip,
  });
  await changed(conversation.accountId, conversation.id);
  return r.id as string;
}

/**
 * Closes the prospect's open reminder. `by` is null when it was closed in Twenty, or automatically (`via: 'auto'`,
 * e.g. the prospect replied to an automatic follow-up).
 */
export async function closeReminder(
  where: { conversationId?: string; reminderId?: string },
  status: Exclude<ReminderStatus, 'OPEN'>,
  by: { id: string } | null,
  ip?: string,
  via: 'app' | 'twenty' | 'auto' = by ? 'app' : 'twenty',
) {
  const [r] = await sql`
    UPDATE reminders SET status = ${status}, closed_at = now(), closed_by = ${by?.id ?? null},
      closed_via = ${via}, updated_at = now()
    WHERE status = 'OPEN' AND ${where.reminderId ? sql`id = ${where.reminderId}` : sql`conversation_id = ${where.conversationId ?? ''}`}
    RETURNING id, conversation_id, account_id`;
  if (!r) return null;
  await audit({
    userId: by?.id ?? null,
    accountId: r.accountId,
    action: 'reminder.closed',
    meta: { conversationId: r.conversationId, status, via },
    ip,
  });
  await changed(r.accountId, r.conversationId);
  return r.id as string;
}
