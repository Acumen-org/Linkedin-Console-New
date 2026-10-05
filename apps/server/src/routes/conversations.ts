import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../db.ts';
import { newId } from '../ids.ts';
import { audit } from '../audit.ts';
import { publish, redis } from '../redis.ts';
import { HttpError, requireUser, type User } from '../auth.ts';
import { accessibleAccountIds, conversationForUser } from '../access.ts';
import { sendCommand } from '../bridgeClient.ts';

const LOCK_SECONDS = 120;

const CONVERSATION_COLUMNS = sql`
  c.id, c.account_id, c.thread_urn, c.thread_id, c.title, c.is_group, c.folder, c.participants,
  c.last_message_at, c.last_message_preview, c.last_message_from_self, c.unread_count,
  c.is_starred, c.is_archived, c.assigned_to, c.locked_by, c.locked_until,
  a.label AS account_label, a.display_name AS account_name, a.avatar_url AS account_avatar, a.status AS account_status,
  lu.name AS locked_by_name, au.name AS assigned_to_name`;

const CONVERSATION_FROM = sql`
  conversations c
  JOIN accounts a ON a.id = c.account_id
  LEFT JOIN users lu ON lu.id = c.locked_by AND c.locked_until > now()
  LEFT JOIN users au ON au.id = c.assigned_to`;

export async function loadConversation(id: string) {
  const [c] = await sql`SELECT ${CONVERSATION_COLUMNS} FROM ${CONVERSATION_FROM} WHERE c.id = ${id}`;
  return c;
}

/** Sends are capped per LinkedIn account per rolling 24h (all teammates combined). */
async function assertCanSend(accountId: string) {
  const [a] = await sql`SELECT status, send_paused, daily_send_cap FROM accounts WHERE id = ${accountId}`;
  if (a.status !== 'CONNECTED') throw new HttpError(409, 'This LinkedIn account is not connected right now');
  if (a.sendPaused) throw new HttpError(409, 'Sending is paused for this account');
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM messages
    WHERE account_id = ${accountId} AND sent_by_user_id IS NOT NULL AND created_at > now() - interval '24 hours' AND status <> 'FAILED'`;
  if (n >= a.dailySendCap) throw new HttpError(429, `Daily send limit reached for this account (${a.dailySendCap}/24h)`);
}

async function uploadsFor(user: User, ids: string[]) {
  if (!ids.length) return [];
  const rows = await sql`SELECT * FROM uploads WHERE id IN ${sql(ids)} AND user_id = ${user.id}`;
  if (rows.length !== ids.length) throw new HttpError(400, 'Unknown attachment');
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

export default async function conversationRoutes(app: FastifyInstance) {
  app.get('/api/conversations', async (req) => {
    const user = requireUser(req);
    const q = z.object({
      accountId: z.string().optional(),
      view: z.enum(['all', 'unread', 'starred', 'archived', 'other', 'requests', 'mine']).default('all'),
      q: z.string().max(200).optional(),
      before: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(40),
    }).parse(req.query);
    let ids = await accessibleAccountIds(user);
    if (q.accountId) ids = ids.filter((id) => id === q.accountId);
    if (!ids.length) return [];
    const term = q.q?.trim();
    const view = {
      all: sql`AND NOT c.is_archived AND c.folder NOT IN ('archived', 'spam')`,
      unread: sql`AND c.unread_count > 0 AND NOT c.is_archived`,
      starred: sql`AND c.is_starred`,
      archived: sql`AND (c.is_archived OR c.folder = 'archived')`,
      other: sql`AND c.folder = 'other' AND NOT c.is_archived`,
      requests: sql`AND c.folder IN ('requests', 'inmail') AND NOT c.is_archived`,
      mine: sql`AND c.assigned_to = ${user.id}`,
    }[q.view];
    return sql`
      SELECT ${CONVERSATION_COLUMNS} FROM ${CONVERSATION_FROM}
      WHERE c.account_id IN ${sql(ids)} ${view}
        ${q.before ? sql`AND c.last_message_at < ${q.before}` : sql``}
        ${term ? sql`AND (
          c.title ILIKE ${'%' + term + '%'}
          OR c.participants::text ILIKE ${'%' + term + '%'}
          OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND to_tsvector('simple', m.text) @@ plainto_tsquery('simple', ${term}))
        )` : sql``}
      ORDER BY c.last_message_at DESC NULLS LAST, c.id
      LIMIT ${q.limit}`;
  });

  app.get('/api/conversations/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { level } = await conversationForUser(user, id, 'READ');
    return { ...(await loadConversation(id)), level };
  });

  app.get('/api/conversations/:id/messages', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await conversationForUser(user, id, 'READ');
    const q = z.object({ before: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(60) }).parse(req.query);
    const rows = await sql`
      SELECT m.id, m.conversation_id, m.message_urn, m.client_id, m.direction, m.sender_urn, m.sender_name, m.sender_avatar_url,
             m.sent_by_user_id, u.name AS sent_by_name, m.text, m.attachments, m.reactions, m.status, m.error, m.deleted, m.seen_at, m.sent_at
      FROM messages m LEFT JOIN users u ON u.id = m.sent_by_user_id
      WHERE m.conversation_id = ${id} ${q.before ? sql`AND m.sent_at < ${q.before}` : sql``}
      ORDER BY m.sent_at DESC LIMIT ${q.limit}`;
    return rows.reverse();
  });

  app.post('/api/conversations/:id/messages', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { conversation } = await conversationForUser(user, id, 'REPLY');
    const body = z.object({
      text: z.string().max(8000).default(''),
      uploadIds: z.array(z.string()).max(5).default([]),
      clientId: z.string().max(64),
    }).parse(req.body);
    if (!body.text.trim() && !body.uploadIds.length) throw new HttpError(400, 'Message is empty');
    const [existing] = await sql`SELECT id FROM messages WHERE client_id = ${body.clientId}`;
    if (existing) return existing; // idempotent retry

    if (conversation.lockedBy && conversation.lockedBy !== user.id && new Date(conversation.lockedUntil) > new Date()) {
      const [holder] = await sql`SELECT name FROM users WHERE id = ${conversation.lockedBy}`;
      throw new HttpError(409, `${holder?.name ?? 'Someone'} is replying to this conversation`);
    }
    if (!conversation.threadId) throw new HttpError(409, 'This conversation cannot be replied to yet (still syncing)');
    await assertCanSend(conversation.accountId);
    const uploads = await uploadsFor(user, body.uploadIds);

    const cmdId = crypto.randomUUID();
    const messageId = newId('msg');
    const attachments = uploads.map((u) => ({ kind: u.mime.startsWith('image/') ? 'image' : 'file', name: u.name, mime: u.mime, size: u.size, uploadId: u.id }));
    await sql`
      INSERT INTO messages (id, conversation_id, account_id, client_id, cmd_id, direction, sent_by_user_id, text, attachments, status, sent_at)
      VALUES (${messageId}, ${id}, ${conversation.accountId}, ${body.clientId}, ${cmdId}, 'OUTBOUND', ${user.id}, ${body.text},
              ${sql.json(attachments as never)}, 'QUEUED', now())`;
    await sendCommand(conversation.accountId, {
      type: 'send_message', cmdId, threadId: conversation.threadId, conversationUrn: conversation.threadUrn, text: body.text,
      files: uploads.map((u) => ({ path: u.path, name: u.name, mime: u.mime })),
    }, user.id);
    // Sending also releases the user's lock.
    await sql`UPDATE conversations SET locked_by = NULL, locked_until = NULL WHERE id = ${id} AND locked_by = ${user.id}`;

    const [msg] = await sql`SELECT m.*, ${user.name}::text AS sent_by_name FROM messages m WHERE id = ${messageId}`;
    await publish(`acc:${conversation.accountId}`, 'message.created', msg);
    await audit({ userId: user.id, accountId: conversation.accountId, action: 'message.send', meta: { conversationId: id, messageId, chars: body.text.length, files: uploads.length }, ip: req.ip });
    return msg;
  });

  // Reading in our inbox marks the thread read on LinkedIn too (the bridge opens it briefly).
  app.post('/api/conversations/:id/read', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { conversation, level } = await conversationForUser(user, id, 'READ');
    if (conversation.unreadCount > 0) {
      await sql`UPDATE conversations SET unread_count = 0 WHERE id = ${id}`;
      const throttle = await redis.set(`lu:markread:${id}`, '1', 'EX', 60, 'NX');
      if (throttle && level !== 'READ' && conversation.threadId) await sendCommand(conversation.accountId, { type: 'mark_read', threadId: conversation.threadId });
      await publish(`acc:${conversation.accountId}`, 'conversation.updated', await loadConversation(id));
    }
    return { ok: true };
  });

  app.patch('/api/conversations/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { conversation } = await conversationForUser(user, id, 'REPLY');
    const body = z.object({
      isStarred: z.boolean().optional(),
      isArchived: z.boolean().optional(),
      assignedTo: z.string().nullable().optional(),
    }).parse(req.body);
    await sql`
      UPDATE conversations SET
        is_starred = ${body.isStarred ?? conversation.isStarred},
        is_archived = ${body.isArchived ?? conversation.isArchived},
        assigned_to = ${body.assignedTo === undefined ? conversation.assignedTo : body.assignedTo}
      WHERE id = ${id}`;
    const c = await loadConversation(id);
    await publish(`acc:${conversation.accountId}`, 'conversation.updated', c);
    if (body.assignedTo !== undefined) await audit({ userId: user.id, accountId: conversation.accountId, action: 'conversation.assigned', meta: { conversationId: id, assignedTo: body.assignedTo } });
    return c;
  });

  // Collision guard: one teammate replies at a time.
  app.post('/api/conversations/:id/lock', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { conversation } = await conversationForUser(user, id, 'REPLY');
    const [row] = await sql`
      UPDATE conversations SET locked_by = ${user.id}, locked_until = now() + ${`${LOCK_SECONDS} seconds`}::interval
      WHERE id = ${id} AND (locked_by IS NULL OR locked_until < now() OR locked_by = ${user.id})
      RETURNING id`;
    const c = await loadConversation(id);
    if (!row) throw new HttpError(409, `${c.lockedByName ?? 'Someone'} is replying to this conversation`);
    await publish(`acc:${conversation.accountId}`, 'conversation.updated', c);
    return c;
  });

  app.delete('/api/conversations/:id/lock', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { conversation } = await conversationForUser(user, id, 'READ');
    await sql`UPDATE conversations SET locked_by = NULL, locked_until = NULL WHERE id = ${id} AND locked_by = ${user.id}`;
    await publish(`acc:${conversation.accountId}`, 'conversation.updated', await loadConversation(id));
    return { ok: true };
  });

  app.post('/api/conversations/:id/sync', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { conversation } = await conversationForUser(user, id, 'REPLY');
    await sendCommand(conversation.accountId, {
      type: 'sync_thread', conversationUrn: conversation.threadUrn, threadId: conversation.threadId, allowOpen: conversation.unreadCount === 0,
    });
    return { ok: true };
  });

  app.get('/api/conversations/:id/notes', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await conversationForUser(user, id, 'READ');
    return sql`SELECT n.id, n.text, n.created_at, n.user_id, u.name AS user_name FROM notes n JOIN users u ON u.id = n.user_id WHERE n.conversation_id = ${id} ORDER BY n.created_at`;
  });

  app.post('/api/conversations/:id/notes', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const { conversation } = await conversationForUser(user, id, 'READ');
    const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(req.body);
    const noteId = newId('note');
    await sql`INSERT INTO notes (id, conversation_id, user_id, text) VALUES (${noteId}, ${id}, ${user.id}, ${text})`;
    const note = { id: noteId, conversationId: id, text, createdAt: new Date().toISOString(), userId: user.id, userName: user.name };
    await publish(`acc:${conversation.accountId}`, 'note.created', note);
    return note;
  });
}
