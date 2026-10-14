import webpush from 'web-push';
import { accountReaders } from '../core/access.ts';
import { RESPONSIBLE } from '../core/reminders-sql.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { vapidKeys } from '../lib/vapid.ts';

/** Sends a notification to these teammates' browsers (those that enabled notifications). */
async function pushTo(userIds: string[], payload: { title: string; body: string; url: string; tag: string }) {
  if (!userIds.length) return;
  const subs = await sql`SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id IN ${sql(userIds)}`;
  if (!subs.length) return;
  await vapidKeys();
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        // Time-boxed: a slow push service must not hold up message processing.
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: 3600, timeout: 5000 });
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // The browser unsubscribed: forget it.
        if (status === 404 || status === 410) await sql`DELETE FROM push_subscriptions WHERE id = ${s.id}`;
        else logger.warn({ err: e, status }, 'push failed');
      }
    }),
  );
}

/** Push notification to everyone who can read the account and enabled notifications. */
export async function notifyNewMessage(
  accountId: string,
  conversationId: string,
  msg: { senderName: string | null; text: string; attachments: unknown[] },
) {
  const [account] = await sql`SELECT label FROM accounts WHERE id = ${accountId}`;
  await pushTo(await accountReaders(accountId), {
    title: `${msg.senderName ?? 'New message'} · ${account?.label ?? 'LinkedIn'}`,
    body: msg.text?.slice(0, 160) || (msg.attachments.length ? '📎 Attachment' : ''),
    url: `/inbox/${conversationId}`,
    tag: conversationId,
  });
}

/**
 * Follow-up reminders that came due: a notification to whoever the reminder is for (the conversation's
 * assignee, else the last teammate who messaged them, else everyone who can reply on the account). Once each.
 */
export async function notifyDueReminders() {
  const due = await sql`
    UPDATE reminders r SET notified_at = now()
    FROM conversations c
    WHERE c.id = r.conversation_id AND r.status = 'OPEN' AND r.due_at <= now() AND r.notified_at IS NULL
    RETURNING r.id, r.note, r.account_id, r.conversation_id, ${RESPONSIBLE} AS responsible,
      coalesce(c.title, c.participants->0->>'name', 'a prospect') AS prospect,
      EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'INBOUND') AS replied`;
  for (const r of due) {
    let to: string[] = r.responsible ? [r.responsible] : [];
    if (!to.length) {
      const rows = await sql`
        SELECT u.id FROM users u
        LEFT JOIN account_grants g ON g.user_id = u.id AND g.account_id = ${r.accountId}
        WHERE u.disabled_at IS NULL AND (u.role IN ('OWNER', 'ADMIN') OR g.level IN ('REPLY', 'FULL'))`;
      to = rows.map((u) => u.id as string);
    }
    await pushTo(to, {
      title: `Follow up: ${r.prospect}${r.replied ? '' : ' (no reply yet)'}`,
      body: r.note?.slice(0, 160) || 'Reminder due now',
      url: `/inbox/${r.conversationId}`,
      tag: `reminder-${r.id}`,
    }).catch((err) => logger.warn({ err }, 'reminder push failed'));
  }
  return due.length;
}
