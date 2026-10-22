// Which LinkedIn prospect is bound to which Twenty Person: the consolidated view of every crm_binding the user can
// see (admins all accounts, everyone else only the accounts they are granted). Search by prospect, filter auto vs
// manual, a scoped summary, CSV export, and an admin Unbind (reuses the per-conversation unbind).
import { useQuery } from '@tanstack/react-query';
import { Check, Download, ExternalLink, Search, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { isAdmin, useMe } from '../../App';
import { Empty } from '../../components/ui';
import { api } from '../../lib/api';
import { fullTime } from '../../lib/format';
import { useAppConfig } from '../../lib/queries';
import { toast } from '../../lib/toast';

interface Binding {
  memberUrn: string;
  prospect: string;
  accountLabels: string[];
  replied: boolean;
  conversationId: string;
  personId: string;
  personName: string | null;
  personUrl: string | null;
  method: string;
  boundByName: string | null;
  boundAt: string;
}
interface BindingsResp {
  bindings: Binding[];
  summary: { bound: number; needsBinding: number; unbound: number };
}

const isAuto = (method: string) => method === 'auto_link' || method === 'auto_new';
const methodLabel = (method: string) =>
  ({
    auto_link: 'Auto · link match',
    auto_new: 'Auto · created new',
    existing: 'Manual · existing',
    new: 'Manual · added new',
    legacy: 'Legacy',
  })[method] ?? method;

/** Formula-safe CSV cell (same guard as the server and Activity exports). */
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

function downloadCsv(rows: Binding[]) {
  const head = [
    'Prospect',
    'Twenty Person',
    'Twenty link',
    'LinkedIn account(s)',
    'Replied',
    'Method',
    'Bound by',
    'Bound at (UTC)',
    'Member URN',
  ];
  const lines = [head.join(',')];
  for (const b of rows)
    lines.push(
      [
        b.prospect,
        b.personName ?? b.personId,
        b.personUrl ?? '',
        b.accountLabels.join(' · '),
        b.replied ? 'yes' : 'no',
        methodLabel(b.method),
        b.boundByName ?? (isAuto(b.method) ? 'Automatic' : ''),
        new Date(b.boundAt).toISOString(),
        b.memberUrn,
      ]
        .map(csvCell)
        .join(','),
    );
  const blob = new Blob([`﻿${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `crm-bindings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function CrmBindingsTab() {
  const me = useMe();
  const appConfig = useAppConfig();
  const [search, setSearch] = useState('');
  const [method, setMethod] = useState<'all' | 'auto' | 'manual'>('all');
  const q = useQuery({ queryKey: ['crm-bindings'], queryFn: () => api.get<BindingsResp>('/api/crm/bindings') });

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (q.data?.bindings ?? []).filter(
      (b) =>
        (method === 'all' || (method === 'auto' ? isAuto(b.method) : !isAuto(b.method))) &&
        (!term || b.prospect.toLowerCase().includes(term) || (b.personName ?? '').toLowerCase().includes(term)),
    );
  }, [q.data, search, method]);

  const unbind = async (b: Binding) => {
    if (
      !confirm(
        `Unbind ${b.prospect} from ${b.personName ?? 'their Twenty Person'}? Their next messages wait until someone binds them again by hand.`,
      )
    )
      return;
    try {
      await api.post(`/api/conversations/${b.conversationId}/crm/unbind`);
      toast('Unbound from Twenty', 'success');
      q.refetch();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // Destructive, admin-only: deletes the Person AND its LinkedIn conversations from Twenty, then unbinds here.
  const unbindDelete = async (b: Binding) => {
    const who = b.personName ?? 'their Twenty Person';
    if (
      !confirm(
        `Permanently DELETE ${who} from Twenty?\n\n` +
          `This removes the Person and all of their LinkedIn conversation records from Twenty — this cannot be undone — then unbinds ${b.prospect} here.\n\n` +
          `To only unbind and keep them in Twenty, use Unbind instead.`,
      )
    )
      return;
    try {
      const r = await api.post<{ personDeleted: boolean; recordsDeleted: number; twentyError: string | null }>(
        `/api/conversations/${b.conversationId}/crm/unbind-delete`,
      );
      if (r.twentyError) toast(`Unbound here, but Twenty delete failed: ${r.twentyError}`, 'error');
      else toast(r.personDeleted ? 'Deleted from Twenty and unbound' : 'Already gone from Twenty; unbound here', 'success');
      q.refetch();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (!appConfig.data?.twentyUrl) return <p className="text-sm text-slate-500">Twenty CRM is not configured.</p>;
  if (q.isLoading) return <p className="text-sm text-slate-500">Loading…</p>;
  if (q.isError) return <p className="text-sm text-red-600">{(q.error as Error).message}</p>;
  const summary = q.data?.summary;

  return (
    <div className="space-y-4">
      {summary && (
        <div className="grid grid-cols-3 gap-3">
          {(
            [
              ['Bound', summary.bound, 'text-emerald-700'],
              ['Need binding', summary.needsBinding, 'text-amber-700'],
              ['Replied, not bound', summary.unbound, 'text-slate-700'],
            ] as const
          ).map(([label, n, color]) => (
            <div key={label} className="card p-3">
              <div className={`text-2xl font-semibold ${color}`}>{n}</div>
              <div className="text-xs text-slate-500">{label}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            className="input pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by prospect or Twenty name"
          />
        </div>
        <div className="flex gap-1">
          {(
            [
              ['all', 'All'],
              ['auto', 'Auto'],
              ['manual', 'Manual'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMethod(id)}
              className={method === id ? 'btn-primary px-3 py-1.5 text-xs' : 'btn-outline px-3 py-1.5 text-xs'}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" onClick={() => downloadCsv(rows)} disabled={!rows.length} className="btn-outline">
          <Download size={16} /> Export
        </button>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-2">Prospect</th>
              <th className="px-4 py-2">Twenty Person</th>
              <th className="px-4 py-2">Account(s)</th>
              <th className="px-4 py-2">Replied</th>
              <th className="px-4 py-2">How</th>
              <th className="px-4 py-2">Bound by</th>
              <th className="px-4 py-2">When</th>
              {isAdmin(me) && <th className="px-4 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((b) => (
              <tr key={b.memberUrn} className="hover:bg-slate-50">
                <td className="px-4 py-2">
                  <a href={`/inbox/${b.conversationId}`} className="font-medium text-brand hover:underline">
                    {b.prospect}
                  </a>
                </td>
                <td className="px-4 py-2">
                  {b.personUrl ? (
                    <a
                      href={b.personUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-brand hover:underline"
                    >
                      <Check size={13} /> {b.personName ?? 'Open in Twenty'} <ExternalLink size={12} />
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-slate-600">
                      <Check size={13} /> {b.personName ?? b.personId}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-600">{b.accountLabels.join(', ')}</td>
                <td className="px-4 py-2">{b.replied ? 'Yes' : <span className="text-slate-400">No</span>}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{methodLabel(b.method)}</td>
                <td className="px-4 py-2 text-slate-600">{b.boundByName ?? (isAuto(b.method) ? 'Automatic' : '—')}</td>
                <td className="px-4 py-2 text-xs text-slate-500">{fullTime(b.boundAt)}</td>
                {isAdmin(me) && (
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button type="button" onClick={() => unbind(b)} className="text-xs text-slate-500 hover:text-brand hover:underline">
                        Unbind
                      </button>
                      <button
                        type="button"
                        onClick={() => unbindDelete(b)}
                        title="Delete this Person and its LinkedIn conversations from Twenty, then unbind (irreversible)"
                        className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-red-600 hover:underline"
                      >
                        <Trash2 size={12} /> Unbind &amp; delete
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <Empty title="No bindings yet">Prospects appear here once they reply and are bound to a Twenty Person.</Empty>}
      </div>
    </div>
  );
}
