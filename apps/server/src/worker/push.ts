import webpush from 'web-push';
import { accountReaders } from '../core/access.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { vapidKeys } from '../lib/vapid.ts';

/** Push notification to everyone who can read the account and enabled notifications. */
export async function notifyNewMessage(
  accountId: string,
  conversationId: string,
  msg: { senderName: string | null; text: string; attachments: unknown[] },
) {
  const userIds = await accountReaders(accountId);
  if (!userIds.length) return;
  const subs = await sql`SELECT id, endpoint, keys FROM push_subscriptions WHERE user_id IN ${sql(userIds)}`;
  if (!subs.length) return;
  await vapidKeys();
  const [account] = await sql`SELECT label FROM accounts WHERE id = ${accountId}`;
  const payload = JSON.stringify({
    title: `${msg.senderName ?? 'New message'} · ${account?.label ?? 'LinkedIn'}`,
    body: msg.text?.slice(0, 160) || (msg.attachments.length ? '📎 Attachment' : ''),
    url: `/inbox/${conversationId}`,
    tag: conversationId,
  });
  await Promise.all(
    subs.map(async (s) => {
      try {
        // Time-boxed: a slow push service must not hold up message processing.
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 3600, timeout: 5000 });
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // The browser unsubscribed: forget it.
        if (status === 404 || status === 410) await sql`DELETE FROM push_subscriptions WHERE id = ${s.id}`;
        else logger.warn({ err: e, status }, 'push failed');
      }
    }),
  );
}
