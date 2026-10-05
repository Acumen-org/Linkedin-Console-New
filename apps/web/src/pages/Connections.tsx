import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Search, Send, Contact as ContactIcon } from 'lucide-react';
import { api, qs } from '../api';
import type { Account, Contact } from '../types';
import { PageScroll } from '../components/Layout';
import { Avatar, Empty, Modal, PageHeader } from '../components/ui';
import { toast } from '../toast';

export function ConnectionsPage() {
  const { accountId } = useParams();
  const nav = useNavigate();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const current = accounts.data?.find((a) => a.id === accountId) ?? accounts.data?.[0];
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [messaging, setMessaging] = useState<Contact | null>(null);
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);

  const list = useQuery({
    queryKey: ['connections', current?.id, q],
    queryFn: () => api.get<{ total: number; items: Contact[] }>(`/api/accounts/${current!.id}/connections${qs({ q })}`),
    enabled: !!current,
  });

  const sync = async () => {
    try { await api.post(`/api/accounts/${current!.id}/sync`, { what: 'connections' }); toast('Syncing connections. This takes a few minutes.'); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <PageScroll>
      <PageHeader title="Network">
        <select className="input w-56" value={current?.id ?? ''} onChange={(e) => nav(`/connections/${e.target.value}`)}>
          {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
        {current && current.level !== 'READ' && <button onClick={sync} className="btn-outline"><RefreshCw size={14} /> Sync</button>}
      </PageHeader>
      {!current && <div className="card"><Empty title="No LinkedIn accounts">Connect an account first.</Empty></div>}
      {current && (
        <div className="card">
          <div className="flex items-center gap-3 border-b border-slate-200 p-3">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
              <input className="input pl-9" placeholder="Search by name, title or company" value={search} onChange={(e) => setSearch(e.target.value)} />
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
                  {c.profileUrl ? <a href={c.profileUrl} target="_blank" rel="noreferrer" className="font-semibold hover:underline">{c.name}</a> : <span className="font-semibold">{c.name}</span>}
                  <div className="truncate text-sm text-slate-600">{c.headline}</div>
                </div>
                {current.level !== 'READ' && <button onClick={() => setMessaging(c)} className="btn-outline">Message</button>}
              </div>
            ))}
          </div>
        </div>
      )}
      {messaging && current && <MessageModal account={current} contact={messaging} onClose={() => setMessaging(null)} />}
    </PageScroll>
  );
}

function MessageModal({ account, contact, onClose }: { account: Account; contact: Contact; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api.post(`/api/accounts/${account.id}/connections/${contact.id}/message`, { text });
      toast('Queued. It will appear in the inbox once LinkedIn confirms.', 'success');
      onClose();
    } catch (e) { toast((e as Error).message, 'error'); setBusy(false); }
  };
  return (
    <Modal title={`Message ${contact.name}`} onClose={onClose}>
      <div className="mb-2 text-xs text-slate-500">Sent from <b>{account.label}</b></div>
      <textarea className="input min-h-32" value={text} onChange={(e) => setText(e.target.value)} autoFocus placeholder="Write a message…" />
      <div className="mt-3 flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={send} disabled={!text.trim() || busy} className="btn-primary"><Send size={14} /> Send</button>
      </div>
    </Modal>
  );
}
