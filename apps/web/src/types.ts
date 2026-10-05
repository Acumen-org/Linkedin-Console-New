export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';
export type Level = 'READ' | 'REPLY' | 'FULL';

export interface User { id: string; email?: string; name: string; role: Role; disabledAt?: string | null }

export type AccountStatus = 'PROVISIONING' | 'AWAITING_LOGIN' | 'CONNECTED' | 'NEEDS_ATTENTION' | 'OFFLINE' | 'ERROR';

export interface Account {
  id: string;
  label: string;
  ownerUserId: string;
  ownerName?: string;
  status: AccountStatus;
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
  unread?: number;
  level: Level;
}

export interface Participant { urn: string; name: string; headline?: string; avatarUrl?: string | null; profileUrl?: string | null }

export interface Conversation {
  id: string;
  accountId: string;
  threadId: string | null;
  title: string | null;
  isGroup: boolean;
  folder: string;
  participants: Participant[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageFromSelf: boolean | null;
  unreadCount: number;
  isStarred: boolean;
  isArchived: boolean;
  assignedTo: string | null;
  assignedToName: string | null;
  lockedBy: string | null;
  lockedByName: string | null;
  lockedUntil: string | null;
  accountLabel: string;
  accountName: string | null;
  accountAvatar: string | null;
  accountStatus: AccountStatus;
  level?: Level;
}

export interface Attachment {
  kind: 'image' | 'file' | 'audio' | 'video' | 'gif' | 'reply' | 'forward' | 'link' | 'unavailable' | 'unknown';
  url?: string | null;
  name?: string;
  mime?: string | null;
  size?: number | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  text?: string;
  title?: string | null;
  uploadId?: string;
}

export interface Message {
  id: string;
  conversationId: string;
  messageUrn: string | null;
  clientId: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  senderUrn: string | null;
  senderName: string | null;
  senderAvatarUrl: string | null;
  sentByUserId: string | null;
  sentByName: string | null;
  text: string;
  attachments: Attachment[];
  reactions: { emoji: string; count: number; viewerReacted: boolean }[];
  status: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED';
  error: string | null;
  deleted: boolean;
  seenAt: string | null;
  sentAt: string;
}

export interface Note { id: string; text: string; createdAt: string; userId: string; userName: string }

export interface Contact { id: string; publicId: string; name: string; headline: string | null; avatarUrl: string | null; profileUrl: string | null }
