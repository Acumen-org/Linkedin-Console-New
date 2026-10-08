// Applies bridge events (normalized LinkedIn data) to the database and notifies browsers,
// webhooks and push subscribers.
import {
  type Account,
  ADMINS_ROOM,
  accountRoom,
  type BridgeEventMap,
  type LiConversation,
  type LiMessage,
  type LiParticipant,
  userRoom,
} from '@linkunify/contracts';
import { audit } from '../core/audit.ts';
import { sendCommand } from '../core/bridge.ts';
import { emitWebhook } from '../core/webhooks.ts';
import { sql } from '../lib/db.ts';
import { newId } from '../lib/ids.ts';
import { publish, redis } from '../lib/redis.ts';
import { loadConversation, loadMessage } from '../modules/conversations/queries.ts';
import { alertAccountStatus } from './alerts.ts';
import { notifyNewMessage } from './push.ts';

const norm = (s: string | null | undefined) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const preview = (m: LiMessage) => norm(m.text).slice(0, 200) || (m.attachments.length ? '📎 Attachment' : '');
const ts = (ms: number | null | undefined) => new Date(ms ?? Date.now());

async function upsertConversation(accountId: string, c: LiConversation) {
  const [row] = await sql`
    INSERT INTO conversations (id, account_id, thread_urn, thread_id, title, is_group, folder, participants, last_message_at, unread_count)
    VALUES (${newId('cnv')}, ${accountId}, ${c.urn}, ${c.threadId}, ${c.title}, ${c.isGroup}, ${c.folder},
            ${sql.json(c.participants as never)}, ${c.lastActivityAt ? ts(c.lastActivityAt) : null}, ${c.unreadCount})
    ON CONFLICT (account_id, thread_urn) DO UPDATE SET
      thread_id = coalesce(excluded.thread_id, conversations.thread_id),
      title = coalesce(excluded.title, conversations.title),
      is_group = excluded.is_group,
      folder = excluded.folder,
      participants = CASE WHEN jsonb_array_length(excluded.participants) > 0 THEN excluded.participants ELSE conversations.participants END,
      last_message_at = greatest(conversations.last_message_at, excluded.last_message_at),
      unread_count = excluded.unread_count
    RETURNING id, (xmax = 0) AS inserted, history_synced_at, unread_count`;
  return row;
}

async function ensureConversation(accountId: string, m: LiMessage) {
  const [c] = await sql`SELECT id FROM conversations WHERE account_id = ${accountId} AND thread_urn = ${m.conversationUrn}`;
  if (c) return c.id as string;
  const threadId = m.conversationUrn.match(/,([^,()]+)\)$/)?.[1] ?? null;
  const participants =
    m.fromSelf || !m.senderUrn ? [] : [{ urn: m.senderUrn, name: m.senderName ?? 'LinkedIn Member', avatarUrl: m.senderAvatarUrl }];
  const row = await upsertConversation(accountId, {
    urn: m.conversationUrn,
    threadId,
    title: null,
    isGroup: false,
    unreadCount: 0,
    lastActivityAt: m.sentAt,
    folder: 'focused',
    participants,
  });
  // We only know this thread from a single message: refresh the list to get full details.
  if (await redis.set(`lu:inboxsync:${accountId}`, '1', 'EX', 120, 'NX')) await sendCommand(accountId, { type: 'sync_inbox', scrolls: 1 });
  return row.id as string;
}

async function requestHistory(accountId: string, conversationId: string, c: LiConversation) {
  await sql`UPDATE conversations SET history_synced_at = now() WHERE id = ${conversationId}`;
  // Opening a thread marks it read on LinkedIn, so the bridge only opens already-read threads.
  await sendCommand(accountId, { type: 'sync_thread', conversationUrn: c.urn, threadId: c.threadId, allowOpen: c.unreadCount === 0 });
}

export async function onConversations(accountId: string, items: LiConversation[]) {
  for (const c of items) {
    if (!c.urn) continue;
    const row = await upsertConversation(accountId, c);
    if (!row.historySyncedAt && c.threadId) await requestHistory(accountId, row.id, c);
    await publish(accountRoom(accountId), 'conversation.updated', await loadConversation(row.id));
  }
}

/**
 * A message we sent from the app shows up from LinkedIn: attach the LinkedIn URN to our row.
 * FAILED rows count too: LinkedIn showing the message proves it was sent (e.g. confirmation came late).
 */
async function matchPendingOutbound(conversationId: string, m: LiMessage) {
  const candidates = await sql`
    SELECT id, text, attachments FROM messages
    WHERE conversation_id = ${conversationId} AND direction = 'OUTBOUND' AND message_urn IS NULL
      AND status IN ('QUEUED', 'SENDING', 'SENT', 'FAILED') AND created_at > now() - interval '30 minutes'
    ORDER BY status = 'FAILED', created_at`;
  const match = candidates.find((r) => norm(r.text) === norm(m.text) && (norm(m.text) || m.attachments.length));
  if (!match) return null;
  await sql`
    UPDATE messages SET message_urn = ${m.urn}, status = 'SENT', error = NULL, sent_at = ${ts(m.sentAt)},
      attachments = CASE WHEN jsonb_array_length(${sql.json(m.attachments as never)}) > 0 THEN ${sql.json(m.attachments as never)} ELSE attachments END,
      sender_urn = ${m.senderUrn}, sender_name = ${m.senderName}
    WHERE id = ${match.id}`;
  return match.id as string;
}

/** start_chat sends have no message row yet; attribute them to the teammate who sent them. */
async function pendingSender(accountId: string, m: LiMessage): Promise<string | null> {
  const list = await redis.lrange(`li:pending:${accountId}`, 0, -1);
  for (const raw of list) {
    const p = JSON.parse(raw);
    if (norm(p.text) === norm(m.text) && Date.now() - p.at < 30 * 60_000) {
      await redis.lrem(`li:pending:${accountId}`, 1, raw);
      return p.userId;
    }
  }
  return null;
}

async function emitMessage(accountId: string, messageId: string, event: 'message.created' | 'message.updated') {
  const msg = await loadMessage(messageId);
  if (msg) await publish(accountRoom(accountId), event, msg);
  return msg;
}

export async function onMessages(accountId: string, items: LiMessage[]) {
  const touched = new Set<string>();
  for (const m of items) {
    if (!m.urn || !m.conversationUrn) continue;
    const conversationId = await ensureConversation(accountId, m);

    let [known] = await sql`SELECT id, conversation_id, attachments, direction, sender_urn FROM messages WHERE message_urn = ${m.urn}`;
    if (known && m.fromSelf && known.direction === 'INBOUND' && !known.senderUrn) {
      // An earlier copy of our own message named no sender and was stored as incoming: drop it, and
      // handle this copy as new (it merges into the teammate's sent message, or is stored as outbound).
      await sql`DELETE FROM messages WHERE id = ${known.id}`;
      await publish(accountRoom(accountId), 'message.deleted', { id: known.id, conversationId: known.conversationId });
      known = undefined;
    }
    if (known) {
      // Fresh LinkedIn URLs (they expire), but keep our local download cache per attachment.
      const old = (known.attachments ?? []) as Record<string, unknown>[];
      const attachments = m.attachments.length
        ? (m.attachments as unknown as Record<string, unknown>[]).map((a, i) =>
            old[i]?.cachedPath ? { ...a, cachedPath: old[i].cachedPath, cachedMime: old[i].cachedMime } : a,
          )
        : old;
      await sql`
        UPDATE messages SET text = ${m.text}, reactions = ${sql.json(m.reactions as never)}, deleted = ${!!m.deleted},
          attachments = ${sql.json(attachments as never)}
        WHERE id = ${known.id}`;
      await emitMessage(accountId, known.id, 'message.updated');
      continue;
    }

    // A copy without a sender can't be from the other side (theirs always name them): if it matches a
    // message a teammate just sent, it is LinkedIn's copy of that one.
    let messageId = m.fromSelf || !m.senderUrn ? await matchPendingOutbound(conversationId, m) : null;
    let freshInbound = false;
    let event: 'message.created' | 'message.updated' = 'message.updated';
    if (!messageId) {
      messageId = newId('msg');
      event = 'message.created';
      const sentBy = m.fromSelf ? await pendingSender(accountId, m) : null;
      await sql`
        INSERT INTO messages (id, conversation_id, account_id, message_urn, direction, sender_urn, sender_name, sender_avatar_url,
                              sent_by_user_id, text, attachments, reactions, status, deleted, sent_at)
        VALUES (${messageId}, ${conversationId}, ${accountId}, ${m.urn}, ${m.fromSelf ? 'OUTBOUND' : 'INBOUND'}, ${m.senderUrn},
                ${m.senderName}, ${m.senderAvatarUrl}, ${sentBy}, ${m.text}, ${sql.json(m.attachments as never)},
                ${sql.json(m.reactions as never)}, 'SENT', ${!!m.deleted}, ${ts(m.sentAt)})
        ON CONFLICT (message_urn) DO NOTHING`;
      // New inbound message newer than what we had → unread +1 (LinkedIn's count corrects it on the next list refresh).
      // A new reply also wakes a snoozed conversation. (History backfill doesn't count.)
      if (!m.fromSelf) {
        const [bumped] = await sql`
          UPDATE conversations SET unread_count = unread_count + 1, snoozed_until = NULL
          WHERE id = ${conversationId} AND (last_message_at IS NULL OR last_message_at < ${ts(m.sentAt)})
          RETURNING id`;
        freshInbound = !!bumped;
      }
    }
    // Messages can arrive out of order: only the newest one sets the preview, and the time never goes backwards.
    const sentAt = ts(m.sentAt);
    const newest = sql`(last_message_at IS NULL OR last_message_at <= ${sentAt} OR last_message_preview IS NULL)`;
    await sql`
      UPDATE conversations SET
        last_message_preview = CASE WHEN ${newest} THEN ${preview(m)} ELSE last_message_preview END,
        last_message_from_self = CASE WHEN ${newest} THEN ${m.fromSelf} ELSE last_message_from_self END,
        last_message_at = greatest(last_message_at, ${sentAt})
      WHERE id = ${conversationId}`;
    const saved = await emitMessage(accountId, messageId, event);
    touched.add(conversationId);
    if (freshInbound && saved) {
      await emitWebhook('message.received', { accountId, conversationId, message: saved });
      await notifyNewMessage(accountId, conversationId, saved).catch(() => {});
    }
  }
  for (const id of touched) await publish(accountRoom(accountId), 'conversation.updated', await loadConversation(id));
}

export async function onSeen(accountId: string, items: BridgeEventMap['seen']) {
  for (const s of items) {
    if (!s.messageUrn) continue;
    const [row] = await sql`
      UPDATE messages SET seen_at = ${ts(s.seenAt)} WHERE message_urn = ${s.messageUrn} AND seen_at IS NULL RETURNING id`;
    if (row) await emitMessage(accountId, row.id, 'message.updated');
  }
}

export async function onTyping(accountId: string, items: BridgeEventMap['typing']) {
  for (const t of items) {
    if (!t.conversationUrn) continue;
    const [c] = await sql`SELECT id, participants FROM conversations WHERE account_id = ${accountId} AND thread_urn = ${t.conversationUrn}`;
    if (!c) continue;
    const who = (c.participants as LiParticipant[]).find((p) => p.urn === t.participantUrn);
    await publish(accountRoom(accountId), 'linkedin.typing', { conversationId: c.id, name: who?.name ?? 'Someone' });
  }
}

export async function onContacts(accountId: string, data: BridgeEventMap['contacts']) {
  for (const p of data.items) {
    if (!p.publicId || !p.name) continue;
    await sql`
      INSERT INTO contacts (id, account_id, public_id, member_urn, name, headline, avatar_url, profile_url, is_connection)
      VALUES (${newId('ctc')}, ${accountId}, ${p.publicId}, ${String(p.urn ?? '').startsWith('urn:') ? p.urn : null}, ${p.name},
              ${p.headline ?? null}, ${p.avatarUrl ?? null}, ${p.profileUrl ?? null}, ${!!data.connections})
      ON CONFLICT (account_id, public_id) DO UPDATE SET
        name = excluded.name,
        headline = coalesce(nullif(excluded.headline, ''), contacts.headline),
        avatar_url = coalesce(excluded.avatar_url, contacts.avatar_url),
        member_urn = coalesce(excluded.member_urn, contacts.member_urn),
        profile_url = coalesce(excluded.profile_url, contacts.profile_url),
        is_connection = contacts.is_connection OR excluded.is_connection,
        updated_at = now()`;
  }
  if (data.items.length) await publish(accountRoom(accountId), 'connections.updated', { accountId, count: data.items.length });
}

export async function onSession(accountId: string, data: BridgeEventMap['session']) {
  const [before] = await sql`SELECT status FROM accounts WHERE id = ${accountId}`;
  if (!before) return;
  const s = data.self;
  await sql`
    UPDATE accounts SET
      status = ${data.status}, last_seen_at = now(), last_error = NULL,
      profile_urn = coalesce(${s?.urn ?? null}, profile_urn),
      display_name = coalesce(${s?.name ?? null}, display_name),
      headline = coalesce(${s?.headline ?? null}, headline),
      public_id = coalesce(${s?.publicId ?? null}, public_id),
      avatar_url = coalesce(${s?.avatarUrl ?? null}, avatar_url)
    WHERE id = ${accountId}`;
  if (before.status !== data.status) {
    await audit({ accountId, action: 'account.status', meta: { from: before.status, to: data.status } });
    const [a] = await sql<
      (Partial<Account> & { id: string })[]
    >`SELECT id, status, display_name, avatar_url, headline, public_id FROM accounts WHERE id = ${accountId}`;
    await publish([accountRoom(accountId), ADMINS_ROOM], 'account.updated', a);
    await alertAccountStatus(accountId, data.status);
    await emitWebhook('account.status', { accountId, from: before.status, to: data.status });
    // First connection: schedule the first connections sync a few minutes later.
    if (data.status === 'CONNECTED') await redis.set(`lu:connsync:${accountId}`, '1', 'EX', 600, 'NX');
  }
}

export async function onResult(accountId: string, r: BridgeEventMap['result']) {
  const owner = await redis.get(`li:cmdowner:${r.cmdId}`);
  let sentAnyway = false;
  if (r.type === 'send_message') {
    const [row] = await sql`SELECT id, message_urn FROM messages WHERE cmd_id = ${r.cmdId}`;
    if (row) {
      if (r.ok && r.messageUrn && !row.messageUrn) {
        await sql.begin(async (tx) => {
          // The bridge may have already stored LinkedIn's copy as a separate row: merge it into ours.
          await tx`DELETE FROM messages WHERE message_urn = ${r.messageUrn!} AND id <> ${row.id} AND cmd_id IS NULL`;
          await tx`UPDATE messages SET message_urn = ${r.messageUrn!} WHERE id = ${row.id}`;
        });
      }
      // A failure report never overrides LinkedIn's own copy: if it already showed up, the message was sent.
      sentAnyway = !r.ok && !!row.messageUrn;
      if (!sentAnyway) {
        await sql`UPDATE messages SET status = ${r.ok ? 'SENT' : 'FAILED'}, error = ${r.ok ? null : (r.error ?? 'Failed')} WHERE id = ${row.id}`;
      }
      const saved = await emitMessage(accountId, row.id, 'message.updated');
      if (r.ok && saved) await emitWebhook('message.sent', { accountId, conversationId: saved.conversationId, message: saved });
    }
  }
  if (owner && !r.ok && !sentAnyway) await publish(userRoom(owner), 'command.failed', { type: r.type, error: r.error, accountId });
  if (owner && r.ok && r.type === 'start_chat') await publish(userRoom(owner), 'command.ok', { type: r.type, accountId });
}
