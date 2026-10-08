import crypto from 'node:crypto';
import { accountRoom } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conversationForUser } from '../../core/access.ts';
import { audit } from '../../core/audit.ts';
import { requireUser, type SessionUser } from '../../core/auth.ts';
import { sendCommand } from '../../core/bridge.ts';
import { sql } from '../../lib/db.ts';
import { badRequest, conflict, HttpError } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { publish } from '../../lib/redis.ts';
import { loadMessage, MESSAGE_COLUMNS } from './queries.ts';

type Params = { id: string };

const SendBody = z.object({
  text: z.string().max(8000).default(''),
  uploadIds: z.array(z.string()).max(5).default([]),
  clientId: z.string().min(1).max(64),
});

/** Sends are capped per LinkedIn account per rolling 24h (all teammates combined). */
export async function assertCanSend(accountId: string) {
  const [a] = await sql`SELECT status, send_paused, daily_send_cap FROM accounts WHERE id = ${accountId}`;
  if (a.status !== 'CONNECTED') throw conflict('This LinkedIn account is not connected right now');
  if (a.sendPaused) throw conflict('Sending is paused for this account');
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM messages
    WHERE account_id = ${accountId} AND sent_by_user_id IS NOT NULL AND created_at > now() - interval '24 hours' AND status <> 'FAILED'`;
  if (n >= a.dailySendCap) throw new HttpError(429, `Daily send limit reached for this account (${a.dailySendCap}/24h)`);
}

async function uploadsFor(user: SessionUser, ids: string[]) {
  if (!ids.length) return [];
  const rows = await sql`SELECT * FROM uploads WHERE id IN ${sql(ids)} AND user_id = ${user.id}`;
  if (rows.length !== ids.length) throw badRequest('Unknown attachment');
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

export default async function messageRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>('/api/conversations/:id/messages', async (req) => {
    const user = requireUser(req);
    await conversationForUser(user, req.params.id, 'READ');
    const q = z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }).parse(req.query);
    const rows = await sql`
      SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN users u ON u.id = m.sent_by_user_id
      WHERE m.conversation_id = ${req.params.id} ${q.before ? sql`AND m.sent_at < ${q.before}` : sql``}
      ORDER BY m.sent_at DESC LIMIT ${q.limit}`;
    return rows.reverse();
  });

  app.post<{ Params: Params }>('/api/conversations/:id/messages', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    const { conversation } = await conversationForUser(user, id, 'REPLY');
    const body = SendBody.parse(req.body);
    if (!body.text.trim() && !body.uploadIds.length) throw badRequest('Message is empty');

    const [existing] = await sql`SELECT id FROM messages WHERE client_id = ${body.clientId}`;
    if (existing) return loadMessage(existing.id); // idempotent retry

    if (conversation.lockedBy && conversation.lockedBy !== user.id && new Date(conversation.lockedUntil) > new Date()) {
      const [holder] = await sql`SELECT name FROM users WHERE id = ${conversation.lockedBy}`;
      throw conflict(`${holder?.name ?? 'Someone'} is replying to this conversation`);
    }
    if (!conversation.threadId) throw conflict('This conversation cannot be replied to yet (still syncing)');
    await assertCanSend(conversation.accountId);
    const uploads = await uploadsFor(user, body.uploadIds);

    const cmdId = crypto.randomUUID();
    const messageId = newId('msg');
    const attachments = uploads.map((u) => ({
      kind: u.mime.startsWith('image/') ? 'image' : 'file',
      name: u.name,
      mime: u.mime,
      size: u.size,
      uploadId: u.id,
    }));
    await sql`
      INSERT INTO messages (id, conversation_id, account_id, client_id, cmd_id, direction, sent_by_user_id, text, attachments, status, sent_at)
      VALUES (${messageId}, ${id}, ${conversation.accountId}, ${body.clientId}, ${cmdId}, 'OUTBOUND', ${user.id}, ${body.text},
              ${sql.json(attachments as never)}, 'QUEUED', now())`;
    await sendCommand(
      conversation.accountId,
      {
        type: 'send_message',
        cmdId,
        threadId: conversation.threadId,
        conversationUrn: conversation.threadUrn,
        text: body.text,
        files: uploads.map((u) => ({ path: u.path, name: u.name, mime: u.mime })),
      },
      user.id,
    );
    // Sending also releases the user's lock.
    await sql`UPDATE conversations SET locked_by = NULL, locked_until = NULL WHERE id = ${id} AND locked_by = ${user.id}`;

    const msg = (await loadMessage(messageId))!;
    await publish(accountRoom(conversation.accountId), 'message.created', msg);
    await audit({
      userId: user.id,
      accountId: conversation.accountId,
      action: 'message.send',
      meta: { conversationId: id, messageId, chars: body.text.length, files: uploads.length },
      ip: req.ip,
    });
    return msg;
  });
}
