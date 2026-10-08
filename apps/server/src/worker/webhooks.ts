import { WEBHOOK_STREAM } from '../core/webhooks.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { newRedis, redis } from '../lib/redis.ts';
import { deliver, type WebhookPayload, type WebhookRow } from '../modules/webhooks/deliver.ts';
import { consumeStream } from './stream.ts';

/** Delivers queued webhook events to every active endpoint subscribed to that event. */
export async function runWebhookDelivery() {
  await consumeStream({
    redis,
    blocking: newRedis(),
    stream: WEBHOOK_STREAM,
    group: 'webhooks',
    consumer: process.env.WORKER_NAME ?? 'worker',
    handle: async (payload: WebhookPayload) => {
      const hooks = await sql<WebhookRow[]>`SELECT id, url, secret FROM webhooks WHERE active AND ${payload.event} = ANY(events)`;
      await Promise.all(
        hooks.map(async (h) => {
          // Circuit breaker: an endpoint that just failed every retry is skipped for a while, so one dead
          // receiver doesn't hold up every event for everyone (its events would be lost after the retries anyway).
          const down = `lu:webhook:down:${h.id}`;
          if (await redis.exists(down)) return;
          const r = await deliver(h, payload).catch((err) => ({ ok: false, error: (err as Error).message }));
          if (!r.ok) {
            logger.warn({ webhook: h.id, error: r.error }, 'webhook delivery failed; pausing this endpoint for 2 minutes');
            await redis.set(down, '1', 'EX', 120);
          }
        }),
      );
    },
  });
}
