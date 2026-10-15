import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Contact as ContactIcon, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PageScroll } from '../../components/Layout';
import { Avatar, Empty, PageHeader } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Account, Contact } from '../../types';

const PAGE_SIZES = [25, 50, 100] as const;

interface ConnectionsPage {
  /** All connections of the account. */
  total: number;
  /** Those the search finds (= total without a search). */
  matching: number;
  offset: number;
  limit: number;
  items: Contact[];
}

export function ConnectionsPage() {
  const { accountId } = useParams();
  const nav = useNavigate();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const current = accounts.data?.find((a) => a.id === accountId) ?? accounts.data?.[0];
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  // One page at a time (the whole network is never loaded at once).
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(() => Number(localStorage.getItem('network.pageSize')) || 50);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  // A new search, account or page size starts again at the first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when these change
  useEffect(() => setPage(0), [q, current?.id, pageSize]);

  const list = useQuery({
    queryKey: ['connections', current?.id, q, page, pageSize],
    queryFn: () =>
      api.get<ConnectionsPage>(`/api/accounts/${current!.id}/connections${qs({ q, offset: page * pageSize, limit: pageSize })}`),
    enabled: !!current,
    // Keep showing the current page while the next one loads (no flicker).
    placeholderData: keepPreviousData,
  });
  const data = list.data;
  const pages = data ? Math.max(1, Math.ceil(data.matching / pageSize)) : 1;
  const from = data && data.matching ? page * pageSize + 1 : 0;
  const to = data ? Math.min((page + 1) * pageSize, data.matching) : 0;

  const sync = async () => {
    try {
      await api.post(`/api/accounts/${current!.id}/sync`, { what: 'connections' });
      toast('Syncing connections. This takes a few minutes.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <PageScroll>
      <PageHeader title="Network">
        <select className="input w-56" value={current?.id ?? ''} onChange={(e) => nav(`/connections/${e.target.value}`)}>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        {current && current.level !== 'READ' && (
          <button onClick={sync} className="btn-outline">
            <RefreshCw size={14} /> Sync
          </button>
        )}
      </PageHeader>
      {!current && (
        <div className="card">
          <Empty title="No LinkedIn accounts">Connect an account first.</Empty>
        </div>
      )}
      {current && (
        <div className="card">
          <div className="flex items-center gap-3 border-b border-slate-200 p-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
              <input
                className="input pl-9"
                placeholder="Search by name, title or company"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <span className="text-sm text-slate-500">
              {q && data ? `${data.matching} of ${data.total}` : (data?.total ?? 0)} connections
            </span>
          </div>
          {data?.items.length === 0 && (
            <Empty icon={<ContactIcon size={32} />} title={q ? 'No matches' : 'No connections synced yet'}>
              {!q && 'Connections sync automatically once a day. Click Sync to start now.'}
            </Empty>
          )}
          <div className={`divide-y divide-slate-100 ${list.isPlaceholderData ? 'opacity-60' : ''}`}>
            {data?.items.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={c.name} src={c.avatarUrl} size={44} />
                <div className="min-w-0 flex-1">
                  {c.profileUrl ? (
                    <a href={c.profileUrl} target="_blank" rel="noreferrer" className="font-semibold hover:underline">
                      {c.name}
                    </a>
                  ) : (
                    <span className="font-semibold">{c.name}</span>
                  )}
                  <div className="truncate text-sm text-slate-600">{c.headline}</div>
                </div>
                {current.level !== 'READ' && (
                  // Opens the chat with them in the inbox (or a new one there).
                  <Link to={`/inbox?account=${current.id}&newChat=${c.id}`} className="btn-outline">
                    Message
                  </Link>
                )}
              </div>
            ))}
          </div>
          {!!data?.matching && (
            <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-2 text-sm text-slate-600">
              <span>
                {from}–{to} of {data.matching}
              </span>
              <label className="flex items-center gap-1.5">
                Per page
                <select
                  className="rounded-md border border-slate-300 px-1.5 py-0.5"
                  value={pageSize}
                  onChange={(e) => {
                    setPageSize(Number(e.target.value));
                    localStorage.setItem('network.pageSize', e.target.value);
                  }}
                >
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  className="btn-ghost px-2"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  title="Previous page"
                >
                  <ChevronLeft size={16} />
                </button>
                <span>
                  Page {page + 1} of {pages}
                </span>
                <button
                  type="button"
                  className="btn-ghost px-2"
                  disabled={page + 1 >= pages}
                  onClick={() => setPage((p) => p + 1)}
                  title="Next page"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </PageScroll>
  );
}
