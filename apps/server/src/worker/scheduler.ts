import { ADMINS_ROOM, accountRoom } from '@linkunify/contracts';
import { sendCommand } from '../core/bridge.ts';
import { emitWebhook } from '../core/webhooks.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { publish, redis } from '../lib/redis.ts';
import { loadConversation } from '../modules/conversations/queries.ts';
import { alertAccountStatus } from './alerts.ts';

/** Mark pods that stopped reporting as OFFLINE (the bridge heartbeats every ~60s). */
async function detectOfflinePods() {
  const offline = await sql`
    UPDATE accounts SET status = 'OFFLINE'
    WHERE status IN ('CONNECTED', 'AWAITING_LOGIN', 'NEEDS_ATTENTION') AND last_seen_at < now() - interval '4 minutes'
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

export function startScheduler() {
  const jobs = [detectOfflinePods, scheduleConnectionSync, wakeSnoozed];
  setInterval(() => {
    for (const job of jobs) job().catch((err) => logger.error({ err, job: job.name }, 'scheduled job failed'));
  }, 60_000);
}
