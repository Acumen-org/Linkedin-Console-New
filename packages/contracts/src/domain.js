/** Shared vocabulary used by every app. */
export const ROLES = ['OWNER', 'ADMIN', 'MEMBER'];
/** Per-account access for MEMBERs. OWNER/ADMIN always have FULL. */
export const LEVELS = ['READ', 'REPLY', 'FULL'];
export const LEVEL_RANK = { READ: 1, REPLY: 2, FULL: 3 };
export const atLeast = (level, min) => !!level && LEVEL_RANK[level] >= LEVEL_RANK[min];
export const ACCOUNT_STATUSES = ['PROVISIONING', 'AWAITING_LOGIN', 'CONNECTED', 'NEEDS_ATTENTION', 'OFFLINE', 'ERROR'];
export const MESSAGE_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED'];
export const FOLDERS = ['focused', 'other', 'requests', 'inmail', 'archived', 'spam'];
export const CONVERSATION_VIEWS = ['all', 'unread', 'awaiting', 'starred', 'mine', 'snoozed', 'other', 'requests', 'archived'];
/** 12 chars [a-z0-9]: account ids double as container names (pod-<id>). */
export const ACCOUNT_ID_RE = /^[a-z0-9]{12}$/;
//# sourceMappingURL=domain.js.map
