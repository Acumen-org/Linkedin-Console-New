import { accountRoom, CONVERSATION_VIEWS } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleAccountIds, conversationForUser } from '../../core/access.ts';
import { audit } from '../../core/audit.ts';
import { requireUser } from '../../core/auth.ts';
import { sendCommand } from '../../core/bridge.ts';
import { emitWebhook } from '../../core/webhooks.ts';
import { sql } from '../../lib/db.ts';
import { conflict } from '../../lib/errors.ts';
import { newId } from '../../lib/ids.ts';
import { publish, redis } from '../../lib/redis.ts';
import { CONVERSATION_COLUMNS, CONVERSATION_FROM, loadConversation } from './queries.ts';

const LOCK_SECONDS = 120;

/** A search term matched literally by ILIKE: % and _ typed by the user are not wildcards. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
type Params = { id: string };

const ListQuery = z.object({
  accountId: z.string().optional(),
  view: z.enum(CONVERSATION_VIEWS).default('all'),
  labelId: z.string().optional(),
  q: z.string().max(200).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
  /** With before: the id of the last row seen (rows with the same time aren't skipped). Alone: the last row had no time. */
  beforeId: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

const Patch = z.object({
  isStarred: z.boolean().optional(),
  isArchived: z.boolean().optional(),
  assignedTo: z.string().nullable().optional(),
  snoozedUntil: z.iso.datetime({ offset: true }).nullable().optional(),
});

export default async function conversationRoutes(app: FastifyInstance) {
  app.get('/api/conversations', async (req) => {
    const user = requireUser(req);
    const q = ListQuery.parse(req.query);
    let ids = await accessibleAccountIds(user);
    if (q.accountId) ids = ids.filter((id) => id === q.accountId);
    if (!ids.length) return [];
    const term = q.q?.trim();
    const awake = sql`(c.snoozed_until IS NULL OR c.snoozed_until <= now())`;
    const view = {
      all: sql`AND NOT c.is_archived AND c.folder NOT IN ('archived', 'spam') AND ${awake}`,
      unread: sql`AND c.unread_count > 0 AND NOT c.is_archived AND ${awake}`,
      awaiting: sql`AND c.last_message_from_self = false AND NOT c.is_archived AND c.folder NOT IN ('archived', 'spam') AND ${awake}`,
      starred: sql`AND c.is_starred`,
      mine: sql`AND c.assigned_to = ${user.id} AND NOT c.is_archived`,
      snoozed: sql`AND c.snoozed_until > now()`,
      other: sql`AND c.folder = 'other' AND NOT c.is_archived AND ${awake}`,
      requests: sql`AND c.folder IN ('requests', 'inmail') AND NOT c.is_archived AND ${awake}`,
      archived: sql`AND (c.is_archived OR c.folder = 'archived')`,
    }[q.view];
    return sql`
      SELECT ${CONVERSATION_COLUMNS} FROM ${CONVERSATION_FROM}
      WHERE c.account_id IN ${sql(ids)} ${view}
        ${q.labelId ? sql`AND EXISTS (SELECT 1 FROM conversation_labels cl WHERE cl.conversation_id = c.id AND cl.label_id = ${q.labelId})` : sql``}
        ${
          // Next page after (time, id) in the list order: newest first, no-time rows last, then by id.
          q.beforeId
            ? q.before
              ? sql`AND (c.last_message_at < ${q.before} OR (c.last_message_at = ${q.before} AND c.id > ${q.beforeId}) OR c.last_message_at IS NULL)`
              : sql`AND c.last_message_at IS NULL AND c.id > ${q.beforeId}`
            : q.before
              ? sql`AND c.last_message_at < ${q.before}`
              : sql``
        }
        ${
          term
            ? // Name/title match (trigram index) or message text match (full-text index), as one id set.
              sql`AND c.id IN (
          SELECT id FROM conversations
          WHERE account_id IN ${sql(ids)} AND (coalesce(title, '') || ' ' || participants::text) ILIKE ${`%${likeEscape(term)}%`}
          UNION
          SELECT conversation_id FROM messages
          WHERE account_id IN ${sql(ids)} AND to_tsvector('simple', text) @@ plainto_tsquery('simple', ${term})
        )`
            : sql``
        }
      ORDER BY c.last_message_at DESC NULLS LAST, c.id
      LIMIT ${q.limit}`;
  });

  app.get<{ Params: Params }>('/api/conversations/:id', async (req) => {
    const user = requireUser(req);
    const { level } = await conversationForUser(user, req.params.id, 'READ');
    return { ...(await loadConversation(req.params.id)), level };
  });

  app.patch<{ Params: Params }>('/api/conversations/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    const { conversation } = await conversationForUser(user, id, 'REPLY');
    const body = Patch.parse(req.body);
    await sql`
      UPDATE conversations SET
        is_starred = ${body.isStarred ?? conversation.isStarred},
        is_archived = ${body.isArchived ?? conversation.isArchived},
        assigned_to = ${body.assignedTo === undefined ? conversation.assignedTo : body.assignedTo},
        snoozed_until = ${body.snoozedUntil === undefined ? conversation.snoozedUntil : body.snoozedUntil}
      WHERE id = ${id}`;
    const c = await loadConversation(id);
    await publish(accountRoom(conversation.accountId), 'conversation.updated', c);
    if (body.assignedTo !== undefined) {
      await audit({
        userId: user.id,
        accountId: conversation.accountId,
        action: 'conversation.assigned',
        meta: { conversationId: id, assignedTo: body.assignedTo },
      });
      await emitWebhook('conversation.assigned', {
        conversationId: id,
        accountId: conversation.accountId,
        assignedTo: body.assignedTo,
        by: user.id,
      });
    }
    return c;
  });

  // Reading in our inbox marks the thread read on LinkedIn too (the bridge opens it briefly).
  app.post<{ Params: Params }>('/api/conversations/:id/read', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    const { conversation, level } = await conversationForUser(user, id, 'READ');
    if (conversation.unreadCount > 0) {
      await sql`UPDATE conversations SET unread_count = 0 WHERE id = ${id}`;
      const first = await redis.set(`lu:markread:${id}`, '1', 'EX', 60, 'NX');
      if (first && level !== 'READ' && conversation.threadId)
        await sendCommand(conversation.accountId, { type: 'mark_read', threadId: conversation.threadId });
      await publish(accountRoom(conversation.accountId), 'conversation.updated', await loadConversation(id));
    }
    return { ok: true };
  });

  // Collision guard: one teammate replies at a time.
  app.post<{ Params: Params }>('/api/conversations/:id/lock', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    const { conversation } = await conversationForUser(user, id, 'REPLY');
    const [row] = await sql`
      UPDATE conversations SET locked_by = ${user.id}, locked_until = now() + ${`${LOCK_SECONDS} seconds`}::interval
      WHERE id = ${id} AND (locked_by IS NULL OR locked_until < now() OR locked_by = ${user.id})
      RETURNING id`;
    const c = await loadConversation(id);
    if (!row) throw conflict(`${c.lockedByName ?? 'Someone'} is replying to this conversation`);
    await publish(accountRoom(conversation.accountId), 'conversation.updated', c);
    return c;
  });

  app.delete<{ Params: Params }>('/api/conversations/:id/lock', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    const { conversation } = await conversationForUser(user, id, 'READ');
    await sql`UPDATE conversations SET locked_by = NULL, locked_until = NULL WHERE id = ${id} AND locked_by = ${user.id}`;
    await publish(accountRoom(conversation.accountId), 'conversation.updated', await loadConversation(id));
    return { ok: true };
  });

  app.put<{ Params: Params }>('/api/conversations/:id/labels', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    const { conversation } = await conversationForUser(user, id, 'REPLY');
    const { labelIds } = z.object({ labelIds: z.array(z.string()).max(20) }).parse(req.body);
    await sql.begin(async (tx) => {
      await tx`DELETE FROM conversation_labels WHERE conversation_id = ${id}`;
      if (labelIds.length) {
        await tx`
          INSERT INTO conversation_labels (conversation_id, label_id)
          SELECT ${id}, l.id FROM labels l WHERE l.id IN ${tx(labelIds)}`;
      }
    });
    const c = await loadConversation(id);
    await publish(accountRoom(conversation.accountId), 'conversation.updated', c);
    return c;
  });

  app.post<{ Params: Params }>('/api/conversations/:id/sync', async (req) => {
    const user = requireUser(req);
    const { conversation } = await conversationForUser(user, req.params.id, 'REPLY');
    await sendCommand(conversation.accountId, {
      type: 'sync_thread',
      conversationUrn: conversation.threadUrn,
      threadId: conversation.threadId,
      allowOpen: conversation.unreadCount === 0,
    });
    return { ok: true };
  });

  app.get<{ Params: Params }>('/api/conversations/:id/notes', async (req) => {
    const user = requireUser(req);
    await conversationForUser(user, req.params.id, 'READ');
    return sql`
      SELECT n.id, n.conversation_id, n.text, n.created_at, n.user_id, u.name AS user_name
      FROM notes n JOIN users u ON u.id = n.user_id WHERE n.conversation_id = ${req.params.id} ORDER BY n.created_at`;
  });

  app.post<{ Params: Params }>('/api/conversations/:id/notes', async (req) => {
    const user = requireUser(req);
    const { id } = req.params;
    const { conversation } = await conversationForUser(user, id, 'READ');
    const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(req.body);
    const noteId = newId('note');
    await sql`INSERT INTO notes (id, conversation_id, user_id, text) VALUES (${noteId}, ${id}, ${user.id}, ${text})`;
    const note = { id: noteId, conversationId: id, text, createdAt: new Date().toISOString(), userId: user.id, userName: user.name };
    await publish(accountRoom(conversation.accountId), 'note.created', note);
    return note;
  });
}
