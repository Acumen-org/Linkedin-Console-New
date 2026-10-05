import os from 'node:os';
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
    consumer: `${os.hostname()}-${process.pid}`,
    handle: async (payload: WebhookPayload) => {
      const hooks = await sql<WebhookRow[]>`SELECT id, url, secret FROM webhooks WHERE active AND ${payload.event} = ANY(events)`;
      await Promise.all(
        hooks.map((h) => deliver(h, payload).catch((err) => logger.warn({ err, webhook: h.id }, 'webhook delivery failed'))),
      );
    },
  });
}
