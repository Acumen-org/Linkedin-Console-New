import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  type AuditCategory,
  type AuditEntry,
  type AuditExportFormat,
  type AuditFilters,
  auditLabel,
} from '@linkedin-console/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Download, X } from 'lucide-react';
import { useState } from 'react';
import { PageScroll } from '../../components/Layout';
import { Empty, PageHeader, Popover } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { fullTime } from '../../lib/format';

type Person = { id: string; name: string; email?: string };
type AccountOption = { id: string; label: string };

/** Date inputs are local days; the API takes instants ('to' exclusive, so the whole "to" day is included). */
const dayStart = (day: string) => (day ? new Date(`${day}T00:00:00`).toISOString() : undefined);
const dayAfter = (day: string) => {
  if (!day) return undefined;
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
};

const ACTIONS_BY_CATEGORY = Object.entries(AUDIT_CATEGORIES).map(([category, name]) => ({
  category: category as AuditCategory,
  name,
  actions: Object.entries(AUDIT_ACTIONS).filter(([, a]) => a.category === category),
}));

function Details({ meta }: { meta: Record<string, unknown> }) {
  const entries = Object.entries(meta ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return null;
  return (
    <span className="text-xs text-slate-500">
      {entries.map(([k, v], i) => (
        <span key={k}>
          {i > 0 && ' · '}
          {k}: <span className="font-mono">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
        </span>
      ))}
    </span>
  );
}

export function AuditPage() {
  const [userId, setUserId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [action, setAction] = useState('');
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const filters: AuditFilters = {
    userId: userId || undefined,
    accountId: accountId || undefined,
    action: action || undefined,
    from: dayStart(fromDay),
    to: dayAfter(toDay),
  };
  const filtered = Object.values(filters).some(Boolean);
  const clear = () => {
    setUserId('');
    setAccountId('');
    setAction('');
    setFromDay('');
    setToDay('');
  };

  const people = useQuery({ queryKey: ['users'], queryFn: () => api.get<Person[]>('/api/users') });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<AccountOption[]>('/api/accounts') });
  const log = useInfiniteQuery({
    queryKey: ['audit', filters],
    queryFn: ({ pageParam }) => api.get<AuditEntry[]>(`/api/audit${qs({ ...filters, before: pageParam })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].id : undefined),
  });
  const rows = log.data?.pages.flat() ?? [];

  // A plain navigation downloads the file with the session cookie; the server streams it.
  const exportAs = (format: AuditExportFormat) => {
    window.location.href = `/api/audit/export${qs({ ...filters, format })}`;
  };

  return (
    <PageScroll>
      <PageHeader title="Audit log">
        <Popover
          width={240}
          trigger={({ toggle }) => (
            <button type="button" onClick={toggle} className="btn-outline">
              <Download size={16} /> Export
            </button>
          )}
        >
          {(close) => (
            <div className="text-sm">
              <p className="px-3 py-2 text-xs text-slate-500">
                {filtered ? 'All entries matching the filters' : 'The whole log'}, newest first. Exports are recorded in the log.
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

      <div className="card mb-4 grid grid-cols-2 gap-3 p-3 md:grid-cols-6">
        <label className="md:col-span-1">
          <span className="label">Person</span>
          <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Everyone</option>
            {people.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="md:col-span-1">
          <span className="label">LinkedIn account</span>
          <select className="input" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">All accounts</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        <label className="md:col-span-2">
          <span className="label">Event</span>
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">All events</option>
            {ACTIONS_BY_CATEGORY.map((c) => (
              <optgroup key={c.category} label={c.name}>
                <option value={c.category}>All: {c.name}</option>
                {c.actions.map(([code, a]) => (
                  <option key={code} value={code}>
                    {a.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          <span className="label">From</span>
          <input type="date" className="input" value={fromDay} max={toDay || undefined} onChange={(e) => setFromDay(e.target.value)} />
        </label>
        <label>
          <span className="label">To</span>
          <input type="date" className="input" value={toDay} min={fromDay || undefined} onChange={(e) => setToDay(e.target.value)} />
        </label>
        {filtered && (
          <div className="col-span-2 md:col-span-6">
            <button type="button" onClick={clear} className="btn-ghost text-xs">
              <X size={14} /> Clear filters
            </button>
          </div>
        )}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Person</th>
              <th className="px-4 py-2">Event</th>
              <th className="px-4 py-2">LinkedIn account</th>
              <th className="px-4 py-2">IP address</th>
              <th className="px-4 py-2">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="whitespace-nowrap px-4 py-2 text-slate-500">{fullTime(e.createdAt)}</td>
                <td className="px-4 py-2">
                  <div>{e.actorName ?? (e.userId ? 'Removed teammate' : 'System')}</div>
                  {e.actorEmail && <div className="text-xs text-slate-500">{e.actorEmail}</div>}
                </td>
                <td className={`px-4 py-2 ${e.action === 'auth.login_failed' ? 'font-medium text-red-600' : ''}`}>
                  {auditLabel(e.action)}
                </td>
                <td className="px-4 py-2">{e.accountLabel ?? ''}</td>
                <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-500" title={e.userAgent ?? undefined}>
                  {e.ip ?? ''}
                </td>
                <td className="max-w-sm px-4 py-2">
                  <Details meta={e.meta} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {log.isSuccess && !rows.length && <Empty title={filtered ? 'No entries match these filters' : 'Nothing recorded yet'} />}
        {log.hasNextPage && (
          <button
            type="button"
            onClick={() => log.fetchNextPage()}
            disabled={log.isFetchingNextPage}
            className="w-full py-3 text-sm font-semibold text-brand hover:bg-slate-50"
          >
            {log.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        )}
      </div>
    </PageScroll>
  );
}
