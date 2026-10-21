/** Shared vocabulary used by every app. */

export const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];
/** Owner and admins: every account, team management. (Members work with granted accounts; auditors only read the audit log.) */
export const isAdminRole = (role: Role | string | null | undefined) => role === 'OWNER' || role === 'ADMIN';
/** Who may read and export the audit log. */
export const canAudit = (role: Role | string | null | undefined) => isAdminRole(role) || role === 'AUDITOR';

/** Per-account access for MEMBERs. OWNER/ADMIN always have FULL. */
export const LEVELS = ['READ', 'REPLY', 'FULL'] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_RANK: Record<Level, number> = { READ: 1, REPLY: 2, FULL: 3 };
export const atLeast = (level: Level | null | undefined, min: Level) => !!level && LEVEL_RANK[level] >= LEVEL_RANK[min];

export const ACCOUNT_STATUSES = ['PROVISIONING', 'AWAITING_LOGIN', 'CONNECTED', 'NEEDS_ATTENTION', 'OFFLINE', 'ERROR'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
/** Statuses the bridge itself reports (the rest are set by the server). */
export type BridgeSessionStatus = Extract<AccountStatus, 'AWAITING_LOGIN' | 'CONNECTED' | 'NEEDS_ATTENTION'>;

export const MESSAGE_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const FOLDERS = ['focused', 'other', 'requests', 'inmail', 'archived', 'spam'] as const;
export type Folder = (typeof FOLDERS)[number];

export const CONVERSATION_VIEWS = [
  'all',
  'replied',
  'no_reply',
  'followups',
  'crm_needed',
  'crm_bound',
  'unread',
  'awaiting',
  'starred',
  'mine',
  'snoozed',
  'other',
  'requests',
  'archived',
] as const;
export type ConversationView = (typeof CONVERSATION_VIEWS)[number];

/** 12 chars [a-z0-9]: account ids double as container names (pod-<id>). */
export const ACCOUNT_ID_RE = /^[a-z0-9]{12}$/;

/** A prospect's follow-up reminder: open, done (followed up) or closed (stop following this prospect). */
export const REMINDER_STATUSES = ['OPEN', 'DONE', 'CLOSED'] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];
