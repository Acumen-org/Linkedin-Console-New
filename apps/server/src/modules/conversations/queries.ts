import type { Conversation, Message } from '@linkunify/contracts';
import { sql } from '../../lib/db.ts';

/** Columns of a conversation as the API returns it (with account, lock, assignee and labels). */
export const CONVERSATION_COLUMNS = sql`
  c.id, c.account_id, c.thread_urn, c.thread_id, c.title, c.is_group, c.folder, c.participants,
  c.last_message_at, c.last_message_preview, c.last_message_from_self, c.unread_count,
  c.is_starred, c.is_archived, c.snoozed_until, c.assigned_to, c.locked_by, c.locked_until,
  a.label AS account_label, a.display_name AS account_name, a.avatar_url AS account_avatar, a.status AS account_status,
  lu.name AS locked_by_name, au.name AS assigned_to_name,
  coalesce((
    SELECT json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color) ORDER BY l.name)
    FROM conversation_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.conversation_id = c.id
  ), '[]'::json) AS labels`;

export const CONVERSATION_FROM = sql`
  conversations c
  JOIN accounts a ON a.id = c.account_id
  LEFT JOIN users lu ON lu.id = c.locked_by AND c.locked_until > now()
  LEFT JOIN users au ON au.id = c.assigned_to`;

export async function loadConversation(id: string): Promise<Conversation> {
  const [c] = await sql<Conversation[]>`SELECT ${CONVERSATION_COLUMNS} FROM ${CONVERSATION_FROM} WHERE c.id = ${id}`;
  return c;
}

/** Messages as the API returns them (with the teammate who sent it). */
export const MESSAGE_COLUMNS = sql`
  m.id, m.conversation_id, m.account_id, m.message_urn, m.client_id, m.direction, m.sender_urn, m.sender_name,
  m.sender_avatar_url, m.sent_by_user_id, u.name AS sent_by_name, m.text, m.attachments, m.reactions, m.status,
  m.error, m.deleted, m.seen_at, m.sent_at`;

export async function loadMessage(id: string): Promise<Message | undefined> {
  const [m] = await sql<
    Message[]
  >`SELECT ${MESSAGE_COLUMNS} FROM messages m LEFT JOIN users u ON u.id = m.sent_by_user_id WHERE m.id = ${id}`;
  return m;
}
