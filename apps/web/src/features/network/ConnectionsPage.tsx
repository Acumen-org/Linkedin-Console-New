import { useQuery } from '@tanstack/react-query';
import { Contact as ContactIcon, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PageScroll } from '../../components/Layout';
import { Avatar, Empty, PageHeader } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Account, Contact } from '../../types';

export function ConnectionsPage() {
  const { accountId } = useParams();
  const nav = useNavigate();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const current = accounts.data?.find((a) => a.id === accountId) ?? accounts.data?.[0];
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const list = useQuery({
    queryKey: ['connections', current?.id, q],
    queryFn: () => api.get<{ total: number; items: Contact[] }>(`/api/accounts/${current!.id}/connections${qs({ q })}`),
    enabled: !!current,
  });

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
            <span className="text-sm text-slate-500">{list.data?.total ?? 0} connections</span>
          </div>
          {list.data?.items.length === 0 && (
            <Empty icon={<ContactIcon size={32} />} title={q ? 'No matches' : 'No connections synced yet'}>
              {!q && 'Connections sync automatically once a day. Click Sync to start now.'}
            </Empty>
          )}
          <div className="divide-y divide-slate-100">
            {list.data?.items.map((c) => (
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
        </div>
      )}
    </PageScroll>
  );
}
