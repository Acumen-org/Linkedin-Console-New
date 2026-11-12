// External event feed (ext plan C5): a replayable, append-only record of outreach events, read over /api/ext/v1 with
// an API key, alongside the signed webhooks (the consumer uses webhooks for speed and the feed to catch up). The
// invitation/connection/message events (C1–C4) call emitExtEvent with the enriched envelope from event-enrich.ts.
import crypto from 'node:crypto';
import type { WebhookEvent } from '@linkedin-console/contracts';
import { sql } from '../lib/db.ts';
import { newId } from '../lib/ids.ts';
import { redis } from '../lib/redis.ts';
import { emitWebhook } from './webhooks.ts';

/** The event types the external feed carries (a subset of WEBHOOK_EVENTS; all also delivered as signed webhooks). */
export const EXT_EVENT_TYPES = ['invitation.sent', 'invitation.withdrawn', 'connection.accepted', 'message.sent'] as const;
export type ExtEventType = (typeof EXT_EVENT_TYPES)[number];

/** Record an external event to the replayable feed only (no webhook). Used where a legacy webhook is kept separately
 * (message.sent keeps its existing payload) so the feed can carry the enriched envelope without changing that webhook. */
export async function recordExtEvent(type: ExtEventType, data: Record<string, unknown>): Promise<void> {
  const payload = { type, at: new Date().toISOString(), ...data };
  await sql`INSERT INTO ext_events (type, data) VALUES (${type}, ${sql.json(payload as never)})`;
}

/** Record to the replayable feed AND queue the signed webhook with the same payload (new event types). */
export async function emitExtEvent(type: ExtEventType, data: Record<string, unknown>): Promise<void> {
  await recordExtEvent(type, data);
  await emitWebhook(type as WebhookEvent, data);
}

/** Delete feed events older than 90 days; runs at most once a day (scheduled). */
export async function pruneExtEvents(): Promise<void> {
  if (!(await redis.set('lu:extprune', '1', 'EX', 23 * 3600, 'NX'))) return;
  await sql`DELETE FROM ext_events WHERE at < now() - interval '90 days'`;
}

// ---------- API keys (admin-managed; hash only) ----------

const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

export interface ApiKeyRow {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** Create a key: the plaintext is returned once and never stored (only its hash). */
export async function createApiKey(name: string, userId: string): Promise<{ id: string; name: string; key: string }> {
  const key = `ext_${crypto.randomBytes(24).toString('base64url')}`;
  const id = newId('key');
  await sql`INSERT INTO ext_api_keys (id, name, key_hash, created_by) VALUES (${id}, ${name}, ${hashKey(key)}, ${userId})`;
  return { id, name, key };
}

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  return sql<ApiKeyRow[]>`SELECT id, name, created_at, last_used_at, revoked_at FROM ext_api_keys ORDER BY created_at DESC`;
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const rows = await sql`UPDATE ext_api_keys SET revoked_at = now() WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
  return rows.length > 0;
}

/** The key id when the key is valid and not revoked, else null. Records that it was used (at most hourly per key, so
 * a polling consumer doesn't cause a DB write per request). */
export async function verifyApiKey(key: string): Promise<string | null> {
  if (!key) return null;
  const [k] = await sql`SELECT id FROM ext_api_keys WHERE key_hash = ${hashKey(key)} AND revoked_at IS NULL`;
  if (!k) return null;
  if (await redis.set(`lu:extused:${k.id}`, '1', 'EX', 3600, 'NX')) {
    await sql`UPDATE ext_api_keys SET last_used_at = now() WHERE id = ${k.id}`;
  }
  return k.id as string;
}
