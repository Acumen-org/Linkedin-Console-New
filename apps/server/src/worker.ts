// Worker process: applies bridge events, delivers webhooks, runs scheduled jobs.
import { type BridgeEvent, EVENTS_STREAM, RESULTS_STREAM } from '@linkedin-console/contracts';
import { migrate, sql } from './lib/db.ts';
import { logger } from './lib/logger.ts';
import { newRedis, redis } from './lib/redis.ts';
import { onContacts, onConversations, onMessages, onResult, onSeen, onSession, onTyping } from './worker/ingest.ts';
import { startScheduler } from './worker/scheduler.ts';
import { consumeStream } from './worker/stream.ts';
import { runWebhookDelivery } from './worker/webhooks.ts';

async function handleBridgeEvent(ev: BridgeEvent) {
  const [exists] = await sql`SELECT 1 FROM accounts WHERE id = ${ev.accountId}`;
  if (!exists) return; // account was deleted
  switch (ev.type) {
    case 'session':
      return onSession(ev.accountId, ev.data);
    case 'conversations':
      return onConversations(ev.accountId, ev.data);
    case 'messages':
      return onMessages(ev.accountId, ev.data);
    case 'seen':
      return onSeen(ev.accountId, ev.data);
    case 'typing':
      return onTyping(ev.accountId, ev.data);
    case 'contacts':
      return onContacts(ev.accountId, ev.data);
    case 'result':
      return onResult(ev.accountId, ev.data);
  }
}

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
