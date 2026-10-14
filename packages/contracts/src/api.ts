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
  /** 'staff_sync' = added from the staff list (Twilio console or Twenty workspace). */
  source?: 'local' | 'staff_sync';
  hasPassword?: boolean;
  microsoftLinked?: boolean;
  lastSignInAt?: string | null;
  /** Staff: how many LinkedIn accounts they are assigned. */
  accountCount?: number;
  /** Their own send limit per 24 hours (null = the team default, 0 = none). */
  dailySendCap?: number | null;
  /** Messages and new chats they sent in the last 24 hours. */
  sent24h?: number;
}

/** First sync of a newly connected account (shown until done). */
export interface AccountSync {
  startedAt: string;
  finishedAt: string | null;
  conversations: { loaded: number; target: number; done: boolean };
  history: { done: number; total: number };
  connections: { loaded: number; total: number | null; done: boolean; etaMinutes: number | null };
}

/** Why a sign-in was refused (sent to the login page as ?error=<code>). */
export const LOGIN_ERRORS = {
  cancelled: 'Sign-in was cancelled.',
  failed: 'Microsoft sign-in failed. Please try again.',
  throttled: 'Too many sign-in attempts. Please wait a few minutes.',
  expired: 'The sign-in took too long. Please try again.',
  not_member: 'Your Microsoft account is not a member of this workspace. Ask an admin to add you.',
  disabled: 'Your access has been disabled. Contact an admin.',
} as const;
export type LoginError = keyof typeof LOGIN_ERRORS;

/** Sign-in and staff directory setup (admins). */
export interface DirectoryInfo {
  microsoft: boolean;
  passwordSignin: 'on' | 'owner';
  staffSync: {
    mode: 'off' | 'disable' | 'provision';
    /** Where the list comes from. */
    kind: 'twilio' | 'twenty';
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
  /** Set when sending was paused automatically after a LinkedIn warning. */
  pausedReason?: string | null;
  dailySendCap: number;
  /** Today's cap: lower than dailySendCap while a newly connected account ramps up. */
  effectiveSendCap?: number;
  rampDaysLeft?: number | null;
  /** New chats (cold outreach) per day, within the daily cap. */
  newChatCap?: number;
  /** Automatic follow-up after this many business days without a reply (0 = off). */
  followupDays?: number;
  hasProxy: boolean;
  lastSeenAt: string | null;
  /** Since when the browser has been reporting without a break (null while it is down). */
  onlineSince?: string | null;
  /** The last automatic restart, and why. */
  lastRestartAt?: string | null;
  lastRestartReason?: string | null;
  /** Automatic restarts in a row that haven't brought it back yet. */
  recoverAttempts?: number;
  lastError: string | null;
  createdAt: string;
  unread?: number;
  level: Level;
  /** Progress of the first sync after connecting (null once it is long done). */
  sync?: AccountSync | null;
}

export interface Label {
  id: string;
  name: string;
  color: string;
}

export interface ConversationReminder {
  id: string;
  dueAt: string;
  note: string | null;
  /** Who it is for: the assignee, else the last teammate who messaged; null = everyone on the account. */
  responsibleUserId: string | null;
  responsibleName: string | null;
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
  /** The prospect in Twenty CRM, once the CRM sync has logged them. */
  twentyPersonId?: string | null;
  /** The open follow-up reminder, if any. */
  reminder?: ConversationReminder | null;
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
  /** Twenty CRM web address ("Open in Twenty" on a prospect), when the CRM sync is on. */
  twentyUrl: string | null;
}

export interface ApiErrorBody {
  error: string;
}
