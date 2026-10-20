// Worker process: applies bridge events, delivers webhooks, runs scheduled jobs.
import fs from 'node:fs/promises';
import { type BridgeEvent, EVENTS_STREAM, RESULTS_STREAM } from '@linkedin-console/contracts';
import { migrate, sql } from './lib/db.ts';
import { logger } from './lib/logger.ts';
import { newRedis, redis } from './lib/redis.ts';
import { onProgress, onSyncResult } from './worker/first-sync.ts';
import {
  onContacts,
  onConversations,
  onConversationsProgress,
  onMessages,
  onResult,
  onSeen,
  onSession,
  onTyping,
} from './worker/ingest.ts';
import { startScheduler } from './worker/scheduler.ts';
import { consumeStream, lastAlive } from './worker/stream.ts';
import { runWebhookDelivery } from './worker/webhooks.ts';

async function handleBridgeEvent(ev: BridgeEvent) {
  const [exists] = await sql`SELECT 1 FROM accounts WHERE id = ${ev.accountId}`;
  if (!exists) return; // account was deleted
  switch (ev.type) {
    case 'session':
      return onSession(ev.accountId, ev.data);
    case 'conversations':
      await onConversations(ev.accountId, ev.data);
      return onConversationsProgress(ev.accountId);
    case 'messages':
      return onMessages(ev.accountId, ev.data);
    case 'seen':
      return onSeen(ev.accountId, ev.data);
    case 'typing':
      return onTyping(ev.accountId, ev.data);
    case 'contacts':
      return onContacts(ev.accountId, ev.data);
    case 'result':
      // Background list/history syncs (sync_inbox, sync_connections, backfill_conversations) update sync state;
      // everything else (sends, media) goes to onResult.
      if (ev.data.type.startsWith('sync_') || ev.data.type === 'backfill_conversations') return onSyncResult(ev.accountId, ev.data);
      return onResult(ev.accountId, ev.data);
    case 'progress':
      return onProgress(ev.accountId, ev.data);
  }
}

/**
 * Health: a heartbeat file the container's health check reads, and a watchdog that restarts a worker whose
 * stream loops stopped (e.g. a Redis connection that never recovered), instead of it silently doing nothing.
 */
const HEARTBEAT = '/tmp/worker-heartbeat';
setInterval(() => {
  const stalled = Date.now() - lastAlive > 3 * 60_000;
  if (stalled) {
    logger.error('worker stream loops stalled for 3 minutes, exiting so the container restarts');
    process.exit(1);
  }
  fs.writeFile(HEARTBEAT, String(Date.now())).catch(() => {});
}, 30_000).unref();

await migrate();
startScheduler();
runWebhookDelivery();
logger.info('worker started');
// A stable name: after a redeploy the new worker picks up entries the previous one hadn't finished.
const consumer = process.env.WORKER_NAME ?? 'worker';
// Command results (e.g. "sent") have their own stream, so a burst of synced messages never delays them.
await Promise.all(
  [EVENTS_STREAM, RESULTS_STREAM].map((stream) =>
    consumeStream<BridgeEvent>({ redis, blocking: newRedis(), stream, group: 'worker', consumer, handle: handleBridgeEvent }),
  ),
);
