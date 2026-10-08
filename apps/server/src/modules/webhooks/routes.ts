import crypto from 'node:crypto';
import { WEBHOOK_EVENTS } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { requireAdmin } from '../../core/auth.ts';
import { sql } from '../../lib/db.ts';
import { notFound } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { deliver, type WebhookRow } from './deliver.ts';

const Webhook = z.object({
  url: z.url({ protocol: /^https?$/ }).max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  active: z.boolean().default(true),
});

const COLUMNS = sql`id, url, events, active, last_status, last_error, last_delivery_at, created_at`;

/** Outgoing webhooks (CRM, Slack, Zapier/n8n…). Payloads are signed with HMAC-SHA256. */
export default async function webhookRoutes(app: FastifyInstance) {
  app.get('/api/webhooks', async (req) => {
    requireAdmin(req);
    return sql`SELECT ${COLUMNS} FROM webhooks ORDER BY created_at`;
  });

  app.post('/api/webhooks', async (req) => {
    const user = requireAdmin(req);
    const body = Webhook.parse(req.body);
    const id = newId('whk');
    const secret = crypto.randomBytes(24).toString('hex');
    await sql`
      INSERT INTO webhooks (id, url, secret, events, active, created_by)
      VALUES (${id}, ${body.url}, ${secret}, ${body.events}, ${body.active}, ${user.id})`;
    await audit({ userId: user.id, action: 'webhook.created', meta: { url: body.url, events: body.events } });
    const [w] = await sql`SELECT ${COLUMNS} FROM webhooks WHERE id = ${id}`;
    return { ...w, secret }; // the secret is only returned once
  });

  app.put<{ Params: { id: string } }>('/api/webhooks/:id', async (req) => {
    const user = requireAdmin(req);
    const body = Webhook.parse(req.body);
    const [w] = await sql`
      UPDATE webhooks SET url = ${body.url}, events = ${body.events}, active = ${body.active}
      WHERE id = ${req.params.id} RETURNING ${COLUMNS}`;
    if (!w) throw notFound();
    await audit({ userId: user.id, action: 'webhook.updated', meta: { id: req.params.id, ...body } });
    return w;
  });

  app.delete<{ Params: { id: string } }>('/api/webhooks/:id', async (req) => {
    const user = requireAdmin(req);
    await sql`DELETE FROM webhooks WHERE id = ${req.params.id}`;
    await audit({ userId: user.id, action: 'webhook.deleted', meta: { id: req.params.id } });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/webhooks/:id/test', async (req) => {
    requireAdmin(req);
    const [w] = await sql<WebhookRow[]>`SELECT id, url, secret FROM webhooks WHERE id = ${req.params.id}`;
    if (!w) throw notFound();
    const result = await deliver(w, {
      event: 'ping',
      data: { message: 'Test delivery from LinkedIn Console' },
      at: new Date().toISOString(),
    });
    return result;
  });
}
