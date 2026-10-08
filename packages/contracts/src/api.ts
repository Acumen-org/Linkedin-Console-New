/** Shapes returned by the HTTP API (camelCase JSON). */
import type { LiAttachment, LiParticipant, LiReaction } from './bridge.js';
import type { AccountStatus, Folder, Level, MessageStatus, Role } from './domain.js';

export interface User {
  id: string;
  name: string;
  email?: string;
  role: Role;
  disabledAt?: string | null;
  createdAt?: string;
  // Admins only:
  disabledReason?: string | null;
  /** 'staff_sync' = added from the Twilio console staff list. */
  source?: 'local' | 'staff_sync';
  hasPassword?: boolean;
  microsoftLinked?: boolean;
  lastSignInAt?: string | null;
}

/** Sign-in and staff directory setup (admins). */
export interface DirectoryInfo {
  microsoft: boolean;
  passwordSignin: 'on' | 'owner';
  staffSync: {
    mode: 'off' | 'disable' | 'provision';
    source: string | null;
    last: {
      at: string;
      ok: boolean;
      error?: string;
      staff?: number;
      linked?: number;
      disabled?: number;
      reenabled?: number;
      provisioned?: number;
    } | null;
  };
}

export interface Account {
  id: string;
  label: string;
  ownerUserId: string;
  ownerName?: string;
  status: AccountStatus;
  profileUrn: string | null;
  displayName: string | null;
  headline: string | null;
  publicId: string | null;
  avatarUrl: string | null;
  timezone: string;
  language: string;
  sendPaused: boolean;
  dailySendCap: number;
  hasProxy: boolean;
  lastSeenAt: string | null;
  lastError: string | null;
  createdAt: string;
  unread?: number;
  level: Level;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface Conversation {
  id: string;
  accountId: string;
  threadUrn: string;
  threadId: string | null;
  title: string | null;
  isGroup: boolean;
  folder: Folder;
  participants: LiParticipant[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageFromSelf: boolean | null;
  unreadCount: number;
  isStarred: boolean;
  isArchived: boolean;
  snoozedUntil: string | null;
  assignedTo: string | null;
  assignedToName: string | null;
  lockedBy: string | null;
  lockedByName: string | null;
  lockedUntil: string | null;
  labels: Label[];
  accountLabel: string;
  accountName: string | null;
  accountAvatar: string | null;
  accountStatus: AccountStatus;
  level?: Level;
}

export interface Message {
  id: string;
  conversationId: string;
  accountId?: string;
  messageUrn: string | null;
  clientId: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  senderUrn: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  sentByUserId: string | null;
  sentByName: string | null;
  text: string;
  attachments: LiAttachment[];
  reactions: LiReaction[];
  status: MessageStatus;
  error: string | null;
  deleted: boolean;
  seenAt: string | null;
  sentAt: string;
}

export interface Note {
  id: string;
  conversationId?: string;
  text: string;
  createdAt: string;
  userId: string;
  userName: string;
}

export interface Contact {
  id: string;
  publicId: string;
  name: string;
  headline: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
}

export interface Template {
  id: string;
  title: string;
  body: string;
  shared: boolean;
  userId: string;
  userName?: string;
}

export const WEBHOOK_EVENTS = ['message.received', 'message.sent', 'conversation.assigned', 'account.status'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}

export interface AppConfig {
  features: { aiDrafts: boolean; push: boolean };
  vapidPublicKey: string | null;
}

export interface ApiErrorBody {
  error: string;
}
