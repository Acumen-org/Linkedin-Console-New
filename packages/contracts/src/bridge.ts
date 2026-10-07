/**
 * Bridge protocol: how the app talks to the per-account bridge (sidecar) over Redis.
 *
 *   li:events                bridge → worker   one stream for all accounts (BridgeEvent)
 *   li:results               bridge → worker   command results only, so send confirmations never wait behind syncs
 *   li:cmd:<accountId>       app → bridge      one stream per account (BridgeCommand)
 *   li:reply:<cmdId>         bridge → app      list, for request/response commands
 */
import type { BridgeSessionStatus, Folder } from './domain.js';

export const EVENTS_STREAM = 'li:events';
export const RESULTS_STREAM = 'li:results';
export const commandStream = (accountId: string) => `li:cmd:${accountId}`;
export const replyKey = (cmdId: string) => `li:reply:${cmdId}`;

// ---------- normalized LinkedIn data ----------

export interface LiParticipant {
  urn: string;
  name: string;
  headline?: string;
  avatarUrl?: string | null;
  profileUrl?: string | null;
}

export type AttachmentKind = 'image' | 'file' | 'audio' | 'video' | 'gif' | 'reply' | 'forward' | 'link' | 'unavailable' | 'unknown';

export interface LiAttachment {
  kind: AttachmentKind;
  url?: string | null;
  name?: string;
  mime?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  thumbUrl?: string | null;
  text?: string;
  title?: string | null;
  urn?: string | null;
  type?: string | null;
  key?: string;
  /** Set by the app: our own upload (outbound message). */
  uploadId?: string;
  /** Set by the app: locally cached copy. */
  cachedPath?: string;
  cachedMime?: string;
}

export interface LiReaction {
  emoji: string;
  count: number;
  viewerReacted: boolean;
}

export interface LiMessage {
  urn: string;
  conversationUrn: string;
  text: string;
  sentAt: number | null;
  senderUrn: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  senderProfileUrl?: string | null;
  fromSelf: boolean;
  attachments: LiAttachment[];
  reactions: LiReaction[];
  edited?: boolean;
  deleted?: boolean;
}

export interface LiConversation {
  urn: string;
  threadId: string | null;
  title: string | null;
  isGroup: boolean;
  unreadCount: number;
  read?: boolean | null;
  lastActivityAt: number | null;
  categories?: string[];
  folder: Folder;
  participants: LiParticipant[];
}

export interface LiProfile {
  urn: string;
  publicId: string;
  name: string;
  headline: string;
  avatarUrl: string | null;
  profileUrl: string;
}

export interface LiSelf {
  urn: string;
  name: string | null;
  publicId: string | null;
  headline: string | null;
  avatarUrl: string | null;
}

export interface LiSeenReceipt {
  messageUrn: string | null;
  seenAt: number | null;
  participantUrn: string | null;
}

export interface LiTyping {
  conversationUrn: string | null;
  participantUrn: string | null;
}

// ---------- events (bridge → app) ----------

export type BridgeEventMap = {
  session: { status: BridgeSessionStatus; self: LiSelf | null };
  conversations: LiConversation[];
  messages: LiMessage[];
  seen: LiSeenReceipt[];
  typing: LiTyping[];
  contacts: { connections: boolean; items: LiProfile[] };
  result: CommandResult;
};
export type BridgeEventType = keyof BridgeEventMap;
export type BridgeEvent = { [K in BridgeEventType]: { accountId: string; type: K; data: BridgeEventMap[K]; at: number } }[BridgeEventType];

export interface CommandResult {
  cmdId: string;
  type: BridgeCommand['type'];
  ok: boolean;
  error?: string;
  messageUrn?: string;
  conversationUrn?: string;
}

// ---------- commands (app → bridge) ----------

export interface FileRef {
  path: string;
  name: string;
  mime: string;
}

export type BridgeCommand = { cmdId?: string } & (
  | { type: 'send_message'; threadId: string; conversationUrn: string; text: string; files: FileRef[] }
  | { type: 'start_chat'; profileUrl: string; text: string; files?: FileRef[] }
  | { type: 'sync_inbox'; scrolls?: number }
  | { type: 'sync_thread'; conversationUrn: string; threadId: string | null; allowOpen: boolean }
  | { type: 'sync_connections'; maxScrolls?: number }
  | { type: 'mark_read'; threadId: string }
  | { type: 'fetch_media'; url: string }
  | { type: 'check_session' }
);

export type FetchMediaReply = { ok: true; path: string; mime: string; size: number } | { ok: false; error: string };
