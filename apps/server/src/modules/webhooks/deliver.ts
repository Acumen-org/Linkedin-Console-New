import crypto from 'node:crypto';
import { sql } from '../../lib/db.ts';

export interface WebhookRow {
  id: string;
  url: string;
  secret: string;
}

export interface WebhookPayload {
  event: string;
  data: Record<string, unknown>;
  at: string;
}

/**
 * POSTs one payload to one endpoint.
 * Headers: X-LinkUnify-Event, X-LinkUnify-Delivery, X-LinkUnify-Signature: sha256=<hex HMAC of the raw body>.
 */
export async function deliver(hook: WebhookRow, payload: WebhookPayload, attempts = 3) {
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
  const deliveryId = crypto.randomUUID();
  let status: number | null = null;
  let error: string | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'LinkUnify-Webhooks/1',
          'x-linkunify-event': payload.event,
          'x-linkunify-delivery': deliveryId,
          'x-linkunify-signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      status = res.status;
      error = res.ok ? null : `HTTP ${res.status}`;
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) break;
    } catch (e) {
      error = (e as Error).message;
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 2000));
  }

  await sql`UPDATE webhooks SET last_status = ${status}, last_error = ${error}, last_delivery_at = now() WHERE id = ${hook.id}`;
  return { ok: !error, status, error, deliveryId };
}
