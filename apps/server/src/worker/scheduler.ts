import { ADMINS_ROOM, accountRoom } from '@linkedin-console/contracts';
import { sendCommand } from '../core/bridge.ts';
import { runStaffSync } from '../core/staff-sync.ts';
import { emitWebhook } from '../core/webhooks.ts';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { publish, redis } from '../lib/redis.ts';
import { loadConversation, loadMessage } from '../modules/conversations/queries.ts';
import { alertAccountStatus } from './alerts.ts';
import { autoFollowups } from './auto-followups.ts';
import { crmSyncTick } from './crm-sync.ts';
import { notifyDueReminders } from './push.ts';
import { reminderSyncTick } from './reminder-sync.ts';

/** Mark pods that stopped reporting as OFFLINE (the bridge heartbeats every ~60s). */
async function detectOfflinePods() {
  const offline = await sql`
    UPDATE accounts SET status = 'OFFLINE'
    WHERE status IN ('CONNECTED', 'AWAITING_LOGIN', 'NEEDS_ATTENTION', 'PROVISIONING') AND last_seen_at < now() - interval '4 minutes'
    RETURNING id, status, display_name, avatar_url, headline, public_id`;
  for (const a of offline) {
    await publish([accountRoom(a.id), ADMINS_ROOM], 'account.updated', a as never);
    await alertAccountStatus(a.id, 'OFFLINE');
    await emitWebhook('account.status', { accountId: a.id, to: 'OFFLINE' });
  }
}

/** Sync each connected account's connections roughly once a day. */
async function scheduleConnectionSync() {
  const connected = await sql`SELECT id FROM accounts WHERE status = 'CONNECTED'`;
  for (const { id } of connected) {
    // Key exists = synced recently (or just connected); expiry = time for the next sync.
    if (await redis.set(`lu:connsync:${id}`, '1', 'EX', 24 * 3600 + Math.floor(Math.random() * 3600), 'NX')) {
      await sendCommand(id, { type: 'sync_connections' });
    }
  }
}

/** Snoozed conversations whose time is up come back to the inbox. */
async function wakeSnoozed() {
  const woken = await sql`
    UPDATE conversations SET snoozed_until = NULL
    WHERE snoozed_until IS NOT NULL AND snoozed_until <= now()
    RETURNING id, account_id`;
  for (const c of woken) await publish(accountRoom(c.accountId), 'conversation.updated', await loadConversation(c.id));
}

/**
 * Sends that never reported back (browser offline, sidecar restarted) fail after 10 minutes instead of
 * showing "sending" forever. The bridge itself skips sends older than 5 minutes, so none goes out later;
 * if one did go out, LinkedIn's copy still turns it into SENT.
 */
async function expireStuckSends() {
  const stuck = await sql`
    UPDATE messages SET status = 'FAILED', error = 'Not sent: the LinkedIn account did not respond in time'
    WHERE status IN ('QUEUED', 'SENDING') AND message_urn IS NULL AND created_at < now() - interval '10 minutes'
    RETURNING id, account_id`;
  for (const m of stuck) {
    const msg = await loadMessage(m.id);
    if (msg) await publish(accountRoom(m.accountId), 'message.updated', msg);
  }
}

/**
 * History that was requested but never confirmed (bridge restarted, command lost, or no history request
 * learned yet for unread threads) is requested again, newest conversations first.
 */
async function retryPendingHistory() {
  const pending = await sql`
    UPDATE conversations c SET history_requested_at = now()
    FROM (
      SELECT c2.id FROM conversations c2 JOIN accounts a ON a.id = c2.account_id AND a.status = 'CONNECTED'
      WHERE c2.history_requested_at < now() - interval '10 minutes' AND c2.history_synced_at IS NULL AND c2.thread_id IS NOT NULL
        AND c2.last_message_at > now() - interval '90 days'
      ORDER BY c2.last_message_at DESC NULLS LAST LIMIT 50
    ) due
    WHERE c.id = due.id
    RETURNING c.account_id, c.thread_urn, c.thread_id, c.unread_count`;
  for (const c of pending) {
    await sendCommand(c.accountId, {
      type: 'sync_thread',
      conversationUrn: c.threadUrn,
      threadId: c.threadId,
      allowOpen: c.unreadCount === 0,
    });
  }
}

/** Follow the Twilio console staff list every STAFF_SYNC_MINUTES (one worker at a time). */
async function staffSync() {
  if (config.staffSync.mode === 'off') return;
  if (!(await redis.set('lu:staffsync:due', '1', 'EX', config.staffSync.minutes * 60 - 5, 'NX'))) return;
  await runStaffSync();
}

export function startScheduler() {
  const jobs = [
    detectOfflinePods,
    scheduleConnectionSync,
    wakeSnoozed,
    expireStuckSends,
    staffSync,
    retryPendingHistory,
    autoFollowups,
    notifyDueReminders,
  ];
  setInterval(() => {
    for (const job of jobs) job().catch((err) => logger.error({ err, job: job.name }, 'scheduled job failed'));
  }, 60_000);
  // Twenty CRM: messages reach it within seconds, a few at a time.
  if (config.crmSync) setInterval(() => crmSyncTick().catch((err) => logger.error({ err }, 'crm sync failed')), 10_000);
  // Follow-up reminders as Twenty tasks, both ways.
  if (config.crmSync) setInterval(() => reminderSyncTick(), 15_000);
}
