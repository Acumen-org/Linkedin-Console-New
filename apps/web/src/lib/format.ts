import type { AccountStatus, Conversation } from '../types';

export function timeAgo(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (diff < 7 * 86400) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export const fullTime = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
};

export function conversationTitle(c: Conversation) {
  if (c.title) return c.title;
  if (!c.participants?.length) return 'LinkedIn conversation';
  return c.participants.map((p) => p.name).join(', ');
}

export const STATUS: Record<AccountStatus, { label: string; color: string }> = {
  PROVISIONING: { label: 'Starting', color: 'bg-slate-400' },
  AWAITING_LOGIN: { label: 'Needs login', color: 'bg-amber-500' },
  CONNECTED: { label: 'Connected', color: 'bg-emerald-500' },
  NEEDS_ATTENTION: { label: 'Needs attention', color: 'bg-red-500' },
  OFFLINE: { label: 'Offline', color: 'bg-slate-500' },
  ERROR: { label: 'Error', color: 'bg-red-600' },
};

export const formatBytes = (n?: number | null) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

export const TIMEZONES = [
  'America/Chicago',
  'America/New_York',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Toronto',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Jakarta',
  'Asia/Tokyo',
  'Australia/Sydney',
];
