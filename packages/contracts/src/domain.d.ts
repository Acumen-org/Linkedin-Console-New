/** Shared vocabulary used by every app. */
export declare const ROLES: readonly ['OWNER', 'ADMIN', 'MEMBER'];
export type Role = (typeof ROLES)[number];
/** Per-account access for MEMBERs. OWNER/ADMIN always have FULL. */
export declare const LEVELS: readonly ['READ', 'REPLY', 'FULL'];
export type Level = (typeof LEVELS)[number];
export declare const LEVEL_RANK: Record<Level, number>;
export declare const atLeast: (level: Level | null | undefined, min: Level) => boolean;
export declare const ACCOUNT_STATUSES: readonly ['PROVISIONING', 'AWAITING_LOGIN', 'CONNECTED', 'NEEDS_ATTENTION', 'OFFLINE', 'ERROR'];
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];
/** Statuses the bridge itself reports (the rest are set by the server). */
export type BridgeSessionStatus = Extract<AccountStatus, 'AWAITING_LOGIN' | 'CONNECTED' | 'NEEDS_ATTENTION'>;
export declare const MESSAGE_STATUSES: readonly ['QUEUED', 'SENDING', 'SENT', 'FAILED'];
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export declare const FOLDERS: readonly ['focused', 'other', 'requests', 'inmail', 'archived', 'spam'];
export type Folder = (typeof FOLDERS)[number];
export declare const CONVERSATION_VIEWS: readonly [
  'all',
  'unread',
  'awaiting',
  'starred',
  'mine',
  'snoozed',
  'other',
  'requests',
  'archived',
];
export type ConversationView = (typeof CONVERSATION_VIEWS)[number];
/** 12 chars [a-z0-9]: account ids double as container names (pod-<id>). */
export declare const ACCOUNT_ID_RE: RegExp;
//# sourceMappingURL=domain.d.ts.map
