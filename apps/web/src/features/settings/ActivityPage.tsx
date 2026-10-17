import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download } from 'lucide-react';
import { useState } from 'react';
import { PageScroll } from '../../components/Layout';
import { Avatar, Empty, PageHeader, Popover } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { fullTime, timeAgo } from '../../lib/format';

interface StaffRow {
  id: string;
  name: string;
  email: string;
  role: string;
  disabledAt: string | null;
  pod: string | null;
  sent: number;
  failed: number;
  conversations: number;
  newChats: number;
  replies: number;
  medianReplyMinutes: number | null;
  followupsOpen: number;
  followupsOverdue: number;
  lastActiveAt: string | null;
}

interface SentMessage {
  id: string;
  createdAt: string;
  status: string;
  error: string | null;
  text: string | null;
  attachments: unknown[] | null;
  conversationId: string;
  accountLabel: string;
  prospect: string;
}

const PRESETS = [
  { days: 1, label: 'Today' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
] as const;

const startOfDaysAgo = (days: number) => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.toISOString();
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const minutes = (m: number | null) =>
  m === null ? '—' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;

/** Reply rate = new chats that got a reply ÷ new chats started. */
const replyRate = (replies: number, newChats: number) => (newChats ? Math.round((100 * replies) / newChats) : null);
const rateStr = (replies: number, newChats: number) => {
  const r = replyRate(replies, newChats);
  return r === null ? '—' : `${r}%`;
};

type PodGroup = { pod: string | null; rows: StaffRow[]; total: Totals };
type Totals = { sent: number; newChats: number; replies: number; followupsOpen: number; followupsOverdue: number };

const addTotals = (rows: StaffRow[]): Totals =>
  rows.reduce(
    (t, s) => ({
      sent: t.sent + s.sent,
      newChats: t.newChats + s.newChats,
      replies: t.replies + s.replies,
      followupsOpen: t.followupsOpen + s.followupsOpen,
      followupsOverdue: t.followupsOverdue + s.followupsOverdue,
    }),
    { sent: 0, newChats: 0, replies: 0, followupsOpen: 0, followupsOverdue: 0 },
  );

/** Group staff by pod, pods first (alphabetical), "No pod" last. */
function groupByPod(staff: StaffRow[]): PodGroup[] {
  const map = new Map<string, StaffRow[]>();
  for (const s of staff) {
    const key = s.pod ?? '';
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)))
    .map(([pod, rows]) => ({ pod: pod || null, rows, total: addTotals(rows) }));
}

/** Formula-safe CSV cell (same guard as the server export). */
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function downloadSummaryCsv(staff: StaffRow[]) {
  const head = [
    'Pod',
    'Teammate',
    'Email',
    'Role',
    'Sent',
    'New chats',
    'Replies',
    'Reply rate %',
    'Follow-ups open',
    'Follow-ups overdue',
    'Median reply (min)',
    'Last active (UTC)',
  ];
  const lines = [head.join(',')];
  for (const s of staff)
    lines.push(
      [
        s.pod ?? 'No pod',
        s.name,
        s.email,
        s.role,
        s.sent,
        s.newChats,
        s.replies,
        replyRate(s.replies, s.newChats) ?? '',
        s.followupsOpen,
        s.followupsOverdue,
        s.medianReplyMinutes ?? '',
        s.lastActiveAt ?? '',
      ]
        .map(csvCell)
        .join(','),
    );
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `outreach-summary-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Staff activity: what each teammate sent (messages only), per account and period, with an export. */
export function ActivityPage() {
  const [days, setDays] = useState<number>(30);
  const [accountId, setAccountId] = useState('');
  const [person, setPerson] = useState<StaffRow | null>(null);
  const filters = { from: startOfDaysAgo(days), accountId: accountId || undefined };

  const options = useQuery({
    queryKey: ['audit-options'],
    queryFn: () => api.get<{ accounts: { id: string; label: string }[] }>('/api/audit/options'),
  });
  const summary = useQuery({
    queryKey: ['activity', days, accountId],
    queryFn: () => api.get<{ staff: StaffRow[] }>(`/api/activity/staff${qs(filters)}`),
  });

  const exportAs = (format: 'csv' | 'json') => {
    window.location.href = `/api/activity/export${qs({ ...filters, userId: person?.id, format })}`;
  };

  return (
    <PageScroll>
      <PageHeader title={person ? `Activity · ${person.name}` : 'Staff activity'}>
        <Popover
          width={260}
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} className="btn-outline">
              <Download size={16} /> Export
            </button>
          )}
        >
          {(close) => (
            <div className="text-sm">
              {!person && (
                <>
                  <button
                    type="button"
                    className="block w-full rounded px-3 py-2 text-left hover:bg-slate-50"
                    onClick={() => {
                      downloadSummaryCsv(summary.data?.staff ?? []);
                      close();
                    }}
                  >
                    Summary by pod (CSV)
                    <span className="block text-xs text-slate-500">Per rep and pod: sent, new chats, replies, reply rate, follow-ups.</span>
                  </button>
                  <div className="my-1 border-t border-slate-100" />
                </>
              )}
              <p className="px-3 py-2 text-xs text-slate-500">
                Every message {person ? person.name : 'the team'} sent in this period, newest first. Exports are recorded in the audit log.
              </p>
              {(
                [
                  ['csv', 'CSV (Excel, Sheets)'],
                  ['json', 'JSON'],
                ] as const
              ).map(([format, name]) => (
                <button
                  key={format}
                  type="button"
                  className="block w-full rounded px-3 py-2 text-left hover:bg-slate-50"
                  onClick={() => {
                    exportAs(format);
                    close();
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
        </Popover>
      </PageHeader>

      <div className="card mb-4 flex flex-wrap items-end gap-3 p-3">
        <div>
          <span className="label">Period</span>
          <div className="flex gap-1">
            {PRESETS.map((p) => (
              <button
                key={p.days}
                type="button"
                onClick={() => setDays(p.days)}
                className={days === p.days ? 'btn-primary px-3 py-1.5 text-xs' : 'btn-outline px-3 py-1.5 text-xs'}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <label>
          <span className="label">LinkedIn account</span>
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {options.data?.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <p className="flex-1 text-xs text-slate-500">Messages sent from this app, per teammate. Reading conversations is not tracked.</p>
      </div>

      {person ? (
        <PersonMessages person={person} filters={filters} onBack={() => setPerson(null)} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">Teammate</th>
                <th className="px-4 py-2 text-right">Sent</th>
                <th className="px-4 py-2 text-right">New chats</th>
                <th className="px-4 py-2 text-right">Replies</th>
                <th className="px-4 py-2 text-right" title="New chats that got a reply ÷ new chats started">
                  Reply rate
                </th>
                <th className="px-4 py-2 text-right" title="Open follow-up reminders (overdue in red)">
                  Follow-ups
                </th>
                <th className="px-4 py-2 text-right" title="Median time from the prospect's message to the reply">
                  Reply time
                </th>
                <th className="px-4 py-2 text-right">Failed</th>
                <th className="px-4 py-2">Last active</th>
              </tr>
            </thead>
            {groupByPod(summary.data?.staff ?? []).map((g) => (
              <tbody key={g.pod ?? '—'} className="divide-y divide-slate-100 border-t-4 border-slate-100">
                <tr className="bg-slate-50/70 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <td className="px-4 py-1.5">{g.pod ?? 'No pod'}</td>
                  <td className="px-4 py-1.5 text-right">{g.total.sent}</td>
                  <td className="px-4 py-1.5 text-right">{g.total.newChats}</td>
                  <td className="px-4 py-1.5 text-right">{g.total.replies}</td>
                  <td className="px-4 py-1.5 text-right">{rateStr(g.total.replies, g.total.newChats)}</td>
                  <td className="px-4 py-1.5 text-right">
                    {g.total.followupsOpen}
                    {g.total.followupsOverdue ? ` (${g.total.followupsOverdue} overdue)` : ''}
                  </td>
                  <td colSpan={3} />
                </tr>
                {g.rows.map((s) => (
                  <tr key={s.id} onClick={() => setPerson(s)} className="cursor-pointer hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <Avatar name={s.name} size={28} />
                        <div>
                          <div className={`font-medium ${s.disabledAt ? 'text-slate-400' : ''}`}>{s.name}</div>
                          <div className="text-xs text-slate-500">{s.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right font-semibold">{s.sent}</td>
                    <td className="px-4 py-2 text-right">{s.newChats}</td>
                    <td className="px-4 py-2 text-right">{s.replies}</td>
                    <td className="px-4 py-2 text-right">{rateStr(s.replies, s.newChats)}</td>
                    <td className="px-4 py-2 text-right">
                      {s.followupsOpen}
                      {s.followupsOverdue ? <span className="text-red-600"> ({s.followupsOverdue})</span> : null}
                    </td>
                    <td className="px-4 py-2 text-right">{minutes(s.medianReplyMinutes)}</td>
                    <td className={`px-4 py-2 text-right ${s.failed ? 'text-red-600' : ''}`}>{s.failed}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">{s.lastActiveAt ? timeAgo(s.lastActiveAt) : 'No messages'}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
          {summary.data?.staff.length === 0 && <Empty title="No staff yet">Add staff on the Team page.</Empty>}
        </div>
      )}
    </PageScroll>
  );
}

function PersonMessages({
  person,
  filters,
  onBack,
}: {
  person: StaffRow;
  filters: { from: string; accountId?: string };
  onBack: () => void;
}) {
  const list = useInfiniteQuery({
    queryKey: ['activity-messages', person.id, filters],
    queryFn: ({ pageParam }) =>
      api.get<SentMessage[]>(
        `/api/activity/staff/${person.id}/messages${qs({ ...filters, before: pageParam?.before, beforeId: pageParam?.id })}`,
      ),
    initialPageParam: undefined as { before: string; id: string } | undefined,
    getNextPageParam: (last) => {
      const row = last[last.length - 1];
      return last.length === 100 && row ? { before: row.createdAt, id: row.id } : undefined;
    },
  });
  const rows = list.data?.pages.flat() ?? [];
  return (
    <div className="card">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2">
        <button type="button" onClick={onBack} className="btn-ghost px-2">
          <ArrowLeft size={16} /> All staff
        </button>
        <span className="text-sm text-slate-600">
          {person.sent} sent · {plural(person.newChats, 'new chat')} · {plural(person.conversations, 'conversation')}
        </span>
      </div>
      {rows.length === 0 && !list.isLoading && <Empty title="No messages in this period" />}
      <div className="divide-y divide-slate-100">
        {rows.map((m) => (
          <div key={m.id} className="px-4 py-2.5 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span title={fullTime(m.createdAt)}>{fullTime(m.createdAt)}</span>
              <span>· to {m.prospect}</span>
              <span>· via {m.accountLabel}</span>
              {m.status !== 'SENT' && (
                <span className={m.status === 'FAILED' ? 'text-red-600' : 'text-amber-600'}>
                  · {m.status.toLowerCase()}
                  {m.error ? `: ${m.error}` : ''}
                </span>
              )}
            </div>
            <div className="mt-0.5 whitespace-pre-wrap break-words">
              {m.text || (m.attachments?.length ? `📎 ${m.attachments.length} attachment(s)` : '')}
            </div>
          </div>
        ))}
      </div>
      {list.hasNextPage && (
        <div className="p-3 text-center">
          <button type="button" onClick={() => list.fetchNextPage()} className="btn-outline text-xs">
            {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
