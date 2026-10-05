import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conversationForUser } from '../../core/access.ts';
import { audit } from '../../core/audit.ts';
import { requireUser } from '../../core/auth.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { redis } from '../../lib/redis.ts';
import { aiEnabled, draftReply } from './drafts.ts';

export default async function aiRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>('/api/conversations/:id/draft', async (req) => {
    const user = requireUser(req);
    if (!aiEnabled()) throw new HttpError(404, 'AI drafts are not enabled on this server');
    const { id } = req.params;
    const { conversation } = await conversationForUser(user, id, 'REPLY');
    const { instruction } = z.object({ instruction: z.string().max(500).optional() }).parse(req.body ?? {});

    // Max 30 drafts per user per hour.
    const key = `lu:ai:${user.id}:${new Date().toISOString().slice(0, 13)}`;
    const n = await redis.incr(key);
    await redis.expire(key, 3600);
    if (n > 30) throw new HttpError(429, 'Draft limit reached, try again later');

    const [account] = await sql`SELECT display_name, label, headline FROM accounts WHERE id = ${conversation.accountId}`;
    const recent = await sql`
      SELECT direction, sender_name, text FROM messages
      WHERE conversation_id = ${id} AND NOT deleted ORDER BY sent_at DESC LIMIT 20`;
    if (!recent.length) throw new HttpError(409, 'No messages to reply to yet');
    const participants = (conversation.participants ?? []) as { name: string }[];

    const draft = await draftReply({
      ownerName: account.displayName ?? account.label,
      ownerHeadline: account.headline,
      contactName: conversation.title || participants.map((p) => p.name).join(', ') || 'the contact',
      transcript: recent.reverse().map((m) => ({ fromSelf: m.direction === 'OUTBOUND', name: m.senderName ?? 'Contact', text: m.text })),
      instruction,
    });
    await audit({ userId: user.id, accountId: conversation.accountId, action: 'ai.draft', meta: { conversationId: id } });
    return { draft };
  });
}
