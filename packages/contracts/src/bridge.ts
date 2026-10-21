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
  /** null = not in this payload (keep what's stored). */
  isGroup: boolean | null;
  unreadCount: number | null;
  read?: boolean | null;
  lastActivityAt: number | null;
  categories?: string[];
  folder: Folder | null;
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
  /** While a list is being loaded: how far it got (total = LinkedIn's own count, when shown). */
  progress: { kind: 'conversations' | 'connections'; loaded: number; total: number | null; done: boolean };
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
  /** LinkedIn signalled a limit or restriction: the app pauses sending on this account. */
  warning?: 'limited' | 'restricted';
  /** A conversation list load: what the page listed, what LinkedIn's data brought, what came from the page. */
  inbox?: InboxCheck;
  /** A history backfill: the oldest message time now held (ms), whether the thread's start was reached, count added. */
  backfill?: { oldestMs: number | null; done: boolean; fetched: number };
}

export interface InboxCheck {
  /** Conversations the LinkedIn page listed. */
  listed: number;
  /** Of those, how many LinkedIn's own data described (the normal way). */
  recognised: number;
  /** Added from the page itself because LinkedIn's data didn't describe them. */
  fromPage: number;
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
  /** target: keep loading the conversation list until this many conversations were seen (first sync). */
  | { type: 'sync_inbox'; scrolls?: number; target?: number }
  /** priority: someone opened this conversation, so it goes before other background work. */
  | { type: 'sync_thread'; conversationUrn: string; threadId: string | null; allowOpen: boolean; priority?: boolean }
  /**
   * Backfill older messages of a thread, paging back from `beforeMs` (the oldest message held, null = from the
   * newest). Fetches up to `maxPages` older pages, then reports the new oldest and whether it reached the start.
   */
  | { type: 'backfill_thread'; conversationUrn: string; threadId: string | null; beforeMs: number | null; maxPages?: number }
  /** progress: report loaded/total while scrolling (the first full sync). */
  | { type: 'sync_connections'; maxScrolls?: number; progress?: boolean }
  /**
   * Backfill the conversation LIST by replaying LinkedIn's own "load older conversations" GraphQL (learned as
   * `conversationsOlder`), paging back by the cursor until no older conversations remain or `maxPages` is hit.
   * No DOM scrolling, so it reaches hundreds of chats without crashing the tab. The reader ingests each page.
   */
  | { type: 'backfill_conversations'; maxPages?: number }
  | { type: 'mark_read'; threadId: string }
  | { type: 'fetch_media'; url: string }
  /** Resolve a prospect's obfuscated member URN (urn:li:fsd_profile:ACoAA…) to their vanity publicIdentifier. */
  | { type: 'resolve_profile'; memberUrn: string }
  | { type: 'check_session' }
  /** Log back in with the stored LinkedIn password when the session dropped (2FA/CAPTCHA still needs a human). */
  | { type: 'login'; username: string; password: string }
);

export type FetchMediaReply = { ok: true; path: string; mime: string; size: number } | { ok: false; error: string };

export type ResolveProfileReply = { ok: true; memberUrn: string; publicId: string } | { ok: false; error: string };
