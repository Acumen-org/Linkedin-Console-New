import type { WebhookEvent } from '@linkunify/contracts';
import { redis } from '../lib/redis.ts';

export const WEBHOOK_STREAM = 'lu:webhooks';

/** Queue an outgoing webhook event; the worker delivers it to every subscribed endpoint. */
export async function emitWebhook(event: WebhookEvent, data: Record<string, unknown>) {
  await redis.xadd(WEBHOOK_STREAM, 'MAXLEN', '~', '10000', '*', 'json', JSON.stringify({ event, data, at: new Date().toISOString() }));
}
