import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount } from '../../core/access.ts';
import { audit } from '../../core/audit.ts';
import { requireUser } from '../../core/auth.ts';
import { sendCommand } from '../../core/bridge.ts';
import { assertCanSend, assertStaffCanSend, watchStaffVolume } from '../../core/send-limits.ts';
import { sql } from '../../lib/db.ts';
import { notFound } from '../../lib/errors.ts';
import { redis } from '../../lib/redis.ts';

/** Each account's LinkedIn connections (synced daily by the bridge). */
export default async function networkRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/accounts/:id/connections', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    await assertAccount(user, id, 'READ');
    const q = z.object({ q: z.string().max(200).optional(), offset: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    const term = q.q?.trim();
    const rows = await sql`
      SELECT id, public_id, name, headline, avatar_url, profile_url, updated_at FROM contacts
      WHERE account_id = ${id} AND is_connection
        ${term ? sql`AND (name ILIKE ${`%${term}%`} OR headline ILIKE ${`%${term}%`})` : sql``}
      ORDER BY name LIMIT 100 OFFSET ${q.offset}`;
    const [{ total }] = await sql`SELECT count(*)::int AS total FROM contacts WHERE account_id = ${id} AND is_connection`;
    return { total, items: rows };
  });

  /**
   * A connection and the existing 1:1 chat with them, if any (Message opens that chat in the inbox instead of
   * starting a new one). Matched by LinkedIn member URN, profile URL, or else by name.
   */
  app.get<{ Params: { id: string; contactId: string } }>('/api/accounts/:id/connections/:contactId', async (req) => {
    const user = requireUser(req);
    const { id, contactId } = req.params;
    await assertAccount(user, id, 'READ');
    const [contact] = await sql`
      SELECT id, public_id, member_urn, name, headline, avatar_url, profile_url FROM contacts
      WHERE id = ${contactId} AND account_id = ${id}`;
    if (!contact) throw notFound('Connection not found');
    const [conversation] = await sql`
      SELECT c.id FROM conversations c
      WHERE c.account_id = ${id} AND NOT c.is_group AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(c.participants) p
        WHERE p->>'urn' = ${contact.memberUrn ?? ''}
           OR rtrim(p->>'profileUrl', '/') ILIKE ${`%/in/${contact.publicId}`}
           OR lower(p->>'name') = lower(${contact.name}))
      ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`;
    const { memberUrn: _urn, ...rest } = contact;
    return { contact: rest, conversationId: (conversation?.id as string | undefined) ?? null };
  });

  app.post<{ Params: { id: string; contactId: string } }>('/api/accounts/:id/connections/:contactId/message', async (req) => {
    const user = requireUser(req);
    const { id, contactId } = req.params;
    await assertAccount(user, id, 'REPLY');
    const { text } = z.object({ text: z.string().min(1).max(8000) }).parse(req.body);
    const [c] = await sql`SELECT * FROM contacts WHERE id = ${contactId} AND account_id = ${id}`;
    if (!c?.profileUrl) throw notFound('Connection not found');
    // Same rules as replies: connected, not paused, within the daily cap.
    await assertStaffCanSend(user);
    await assertCanSend(id, 'new_chat');
    // The new conversation arrives through the bridge; remember who sent it for "sent by".
    const key = `li:pending:${id}`;
    await redis
      .multi()
      .lpush(key, JSON.stringify({ text, userId: user.id, at: Date.now() }))
      .ltrim(key, 0, 50)
      .expire(key, 3600)
      .exec();
    const cmdId = await sendCommand(id, { type: 'start_chat', profileUrl: c.profileUrl, text }, user.id);
    await audit({ userId: user.id, accountId: id, action: 'message.start_chat', meta: { contactId, chars: text.length }, ip: req.ip });
    watchStaffVolume(user).catch((err) => req.log.warn({ err }, 'volume check failed'));
    return { ok: true, cmdId };
  });
}
