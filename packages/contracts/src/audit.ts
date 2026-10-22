/** Audit trail: every recorded action, its readable name and its category (used by the page, filters and exports). */

export const AUDIT_CATEGORIES = {
  auth: 'Sign-in & security',
  message: 'Messaging',
  conversation: 'Conversations',
  live: 'Live LinkedIn',
  account: 'LinkedIn accounts',
  user: 'Team',
  settings: 'Settings',
  audit: 'Audit log',
} as const;
export type AuditCategory = keyof typeof AUDIT_CATEGORIES;

export const AUDIT_ACTIONS = {
  'setup.owner_created': { label: 'Created the owner account', category: 'auth' },
  'auth.login': { label: 'Signed in', category: 'auth' },
  'auth.login_failed': { label: 'Failed sign-in', category: 'auth' },
  'auth.logout': { label: 'Signed out', category: 'auth' },
  'auth.password_changed': { label: 'Changed own password', category: 'auth' },
  'message.send': { label: 'Sent a message', category: 'message' },
  'message.start_chat': { label: 'Started a new chat', category: 'message' },
  'ai.draft': { label: 'Generated an AI draft', category: 'message' },
  'conversation.assigned': { label: 'Assigned a conversation', category: 'conversation' },
  'conversation.read': { label: 'Read a conversation', category: 'conversation' },
  'reminder.set': { label: 'Set a follow-up reminder', category: 'conversation' },
  'reminder.closed': { label: 'Closed a follow-up reminder', category: 'conversation' },
  'live.opened': { label: 'Opened Live LinkedIn', category: 'live' },
  'live.unlocked': { label: 'Unlocked Live LinkedIn with the LinkedIn password', category: 'live' },
  'live.unlock_failed': { label: 'Wrong LinkedIn password for Live LinkedIn', category: 'live' },
  'account.created': { label: 'Connected a LinkedIn account', category: 'account' },
  'account.deleted': { label: 'Disconnected a LinkedIn account', category: 'account' },
  'account.updated': { label: 'Changed account settings', category: 'account' },
  'account.status': { label: 'Account status changed', category: 'account' },
  'account.restarted': { label: 'Restarted an account browser', category: 'account' },
  'account.auto_restarted': { label: 'Restarted an account browser automatically', category: 'account' },
  'account.auto_login': { label: 'Logged back in automatically with the stored password', category: 'account' },
  'account.sync_degraded': { label: "Chats not syncing fully (LinkedIn's data not readable)", category: 'account' },
  'account.load_all_chats': { label: 'Started loading all chats', category: 'account' },
  'account.resynced': { label: 'Ran the full sync again (chats, history, connections)', category: 'account' },
  'account.imported': { label: 'Imported a LinkedIn data archive', category: 'account' },
  'account.auto_paused': { label: 'Sending paused automatically (LinkedIn warning)', category: 'account' },
  'account.grants_changed': { label: 'Changed who can access an account', category: 'account' },
  'account.credentials_set': { label: 'Set the stored LinkedIn login', category: 'account' },
  'account.credentials_cleared': { label: 'Removed the stored LinkedIn login', category: 'account' },
  'user.created': { label: 'Added a teammate', category: 'user' },
  'user.updated': { label: 'Changed a teammate', category: 'user' },
  'user.owner_transferred': { label: 'Handed over ownership', category: 'user' },
  'user.provisioned': { label: 'Added from the staff list', category: 'user' },
  'user.deprovisioned': { label: 'Disabled: left per the staff list', category: 'user' },
  'user.reenabled': { label: 'Re-enabled per the staff list', category: 'user' },
  'user.sync_run': { label: 'Ran the staff sync', category: 'user' },
  'user.volume_alert': { label: 'Unusual sending volume (admins alerted)', category: 'user' },
  'settings.staff_limits': { label: 'Changed the staff send limits', category: 'settings' },
  'label.created': { label: 'Created a label', category: 'settings' },
  'label.deleted': { label: 'Deleted a label', category: 'settings' },
  'webhook.created': { label: 'Added a webhook', category: 'settings' },
  'webhook.updated': { label: 'Changed a webhook', category: 'settings' },
  'webhook.deleted': { label: 'Deleted a webhook', category: 'settings' },
  'audit.exported': { label: 'Exported the audit log', category: 'audit' },
  'conversations.exported': { label: 'Exported chats', category: 'message' },
  'activity.exported': { label: 'Exported staff activity', category: 'message' },
  'crm.retried': { label: 'Retried the Twenty CRM sync', category: 'settings' },
  'crm.bound': { label: 'Bound a prospect to a Twenty Person', category: 'conversation' },
  'crm.unbound': { label: 'Unbound a prospect from Twenty', category: 'conversation' },
  'crm.deleted_in_twenty': { label: 'Unbound and deleted a prospect from Twenty', category: 'conversation' },
  'integrations.updated': { label: 'Changed the Twenty / staff integration settings', category: 'settings' },
  'integrations.fields_applied': { label: 'Set up Twenty fields from the console', category: 'settings' },
  'crm.autocreate_paused': { label: 'Auto-create paused automatically (hourly safety limit)', category: 'settings' },
} as const satisfies Record<string, { label: string; category: AuditCategory }>;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const auditLabel = (action: string) => (AUDIT_ACTIONS as Record<string, { label: string }>)[action]?.label ?? action;

/** One entry as the API returns it. Names are as they were when it happened. */
export interface AuditEntry {
  id: number;
  createdAt: string;
  action: string;
  userId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  accountId: string | null;
  accountLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  meta: Record<string, unknown>;
}

/** Filters shared by the list and the export (all optional; dates are ISO 8601, `to` is exclusive). */
export interface AuditFilters {
  userId?: string;
  accountId?: string;
  /** An action ('auth.login') or a whole category ('auth'). */
  action?: string;
  from?: string;
  to?: string;
}

export const AUDIT_EXPORT_FORMATS = ['csv', 'json'] as const;
export type AuditExportFormat = (typeof AUDIT_EXPORT_FORMATS)[number];
