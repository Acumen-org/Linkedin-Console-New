import type { InviteReply, SearchFilters, SearchPeopleReply } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertAccount } from '../../core/access.ts';
import { audit } from '../../core/audit.ts';
import { requireUser } from '../../core/auth.ts';
import { requestCommand, sendCommand } from '../../core/bridge.ts';
import { assertCanInvite, assertCanSearch, assertCanSend, assertStaffCanSend, watchStaffVolume } from '../../core/send-limits.ts';
import { config } from '../../lib/config.ts';
import { likeEscape, sql } from '../../lib/db.ts';
import { conflict, notFound } from '../../lib/errors.ts';
import { redis } from '../../lib/redis.ts';

/** Each account's LinkedIn connections (synced daily by the bridge). */
export default async function networkRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/accounts/:id/connections', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    await assertAccount(user, id, 'READ');
    // One page at a time: the browser never loads the whole network.
    const q = z
      .object({
        q: z.string().max(200).optional(),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(10).max(100).default(50),
      })
      .parse(req.query);
    const term = q.q?.trim();
    const like = term ? `%${likeEscape(term)}%` : null;
    const filter = like ? sql`AND (name ILIKE ${like} OR headline ILIKE ${like})` : sql``;
    const rows = await sql`
      SELECT id, public_id, name, headline, avatar_url, profile_url, updated_at FROM contacts
      WHERE account_id = ${id} AND is_connection ${filter}
      ORDER BY name, id LIMIT ${q.limit} OFFSET ${q.offset}`;
    const [{ total, matching }] = await sql`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE true ${filter})::int AS matching
      FROM contacts WHERE account_id = ${id} AND is_connection`;
    // total: all connections; matching: those the search finds (= total without a search).
    return { total, matching, offset: q.offset, limit: q.limit, items: rows };
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

  /**
   * Search all of LinkedIn for people (non-connections included) through this account's live session. Admin-enabled
   * (searchEnabled) and capped per account per day; every search is audited. One page (~10) at a time. Results are
   * ephemeral — never stored as contacts.
   */
  app.get<{ Params: { id: string } }>('/api/accounts/:id/search', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    await assertAccount(user, id, 'REPLY');
    if (!config.searchEnabled) throw conflict('LinkedIn people-search is turned off. An admin can enable it in Settings → Integrations.');
    const q = z
      .object({
        q: z.string().trim().min(1).max(300),
        page: z.coerce.number().int().min(1).max(100).default(1),
        title: z.string().trim().max(200).optional(),
        company: z.string().trim().max(200).optional(),
        location: z.string().trim().max(200).optional(),
        degree: z.enum(['2', '3']).optional(),
      })
      .parse(req.query);
    // Connected + under the daily search cap.
    await assertCanSearch(id);
    const filters: SearchFilters = {
      title: q.title,
      currentCompany: q.company,
      location: q.location,
      network: q.degree === '2' ? ['S'] : q.degree === '3' ? ['O'] : undefined,
    };
    const reply = await requestCommand<SearchPeopleReply>(id, { type: 'search_people', keywords: q.q, filters, page: q.page }, 45);
    await audit({ userId: user.id, accountId: id, action: 'network.search', meta: { chars: q.q.length, page: q.page }, ip: req.ip });
    if (!reply.ok) throw conflict(reply.error || 'LinkedIn search failed');
    return { results: reply.results, total: reply.total, limited: reply.limited ?? false, page: q.page };
  });

  /**
   * Send a connection request to a person found in search. Same gate as search (searchEnabled, REPLY grant), its own
   * conservative daily cap, and an audit entry. `memberUrn` is the (often obfuscated) member URN from a search result.
   */
  app.post<{ Params: { id: string } }>('/api/accounts/:id/invite', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    await assertAccount(user, id, 'REPLY');
    if (!config.searchEnabled) throw conflict('LinkedIn people-search is turned off. An admin can enable it in Settings → Integrations.');
    const { memberUrn, note } = z
      .object({ memberUrn: z.string().regex(/^urn:li:fsd_profile:/, 'a member URN is required'), note: z.string().max(300).optional() })
      .parse(req.body);
    // Connected + under the daily invite cap; also counts against the teammate's own send limit.
    await assertStaffCanSend(user);
    await assertCanInvite(id);
    const reply = await requestCommand<InviteReply>(id, { type: 'invite', memberUrn, note }, 45);
    await audit({ userId: user.id, accountId: id, action: 'network.invite', meta: { memberUrn, hasNote: !!note?.trim() }, ip: req.ip });
    if (!reply.ok) throw conflict(reply.error || 'The connection request could not be sent');
    return { ok: true, already: reply.already ?? false };
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
