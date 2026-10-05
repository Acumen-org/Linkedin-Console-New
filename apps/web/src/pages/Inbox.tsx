import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Search, Star, Lock, Users, MessagesSquare, Plus, Mail, Archive, Inbox as InboxIcon, UserCheck, Layers } from 'lucide-react';
import { api, qs } from '../api';
import type { Account, Conversation } from '../types';
import { Avatar, Empty, StatusDot } from '../components/ui';
import { Thread } from '../components/Thread';
import { conversationTitle, timeAgo } from '../util';

const VIEWS = [
  { id: 'all', label: 'All', icon: InboxIcon },
  { id: 'unread', label: 'Unread', icon: Mail },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'mine', label: 'Assigned to me', icon: UserCheck },
  { id: 'other', label: 'Other', icon: Layers },
  { id: 'requests', label: 'Requests & InMail', icon: MessagesSquare },
  { id: 'archived', label: 'Archived', icon: Archive },
] as const;

export function InboxPage() {
  const { conversationId } = useParams();
  const [params, setParams] = useSearchParams();
  const accountId = params.get('account') ?? '';
  const view = params.get('view') ?? 'all';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [q, setQ] = useState(search);
  useEffect(() => { const t = setTimeout(() => setQ(search.trim()), 300); return () => clearTimeout(t); }, [search]);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const totalUnread = accounts.data?.reduce((n, a) => n + (a.unread ?? 0), 0) ?? 0;

  const list = useInfiniteQuery({
    queryKey: ['conversations', accountId, view, q],
    queryFn: ({ pageParam }) => api.get<Conversation[]>(`/api/conversations${qs({ accountId, view, q, before: pageParam })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length === 40 ? last[last.length - 1].lastMessageAt ?? undefined : undefined),
  });
  const conversations = useMemo(() => list.data?.pages.flat() ?? [], [list.data]);

  return (
    <div className="flex h-full">
      {/* Accounts + views */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold">Inbox</div>
        <div className="flex-1 overflow-y-auto p-2">
          {VIEWS.map((v) => (
            <button key={v.id} onClick={() => setParam('view', v.id === 'all' ? '' : v.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm ${view === v.id ? 'bg-blue-50 font-semibold text-brand' : 'text-slate-700 hover:bg-slate-100'}`}>
              <v.icon size={16} /> {v.label}
              {v.id === 'unread' && totalUnread > 0 && <span className="ml-auto text-xs text-slate-500">{totalUnread}</span>}
            </button>
          ))}
          <div className="mb-1 mt-4 flex items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            LinkedIn accounts
            <Link to="/accounts" title="Connect an account" className="text-brand"><Plus size={16} /></Link>
          </div>
          <button onClick={() => setParam('account', '')}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm ${!accountId ? 'bg-blue-50 font-semibold text-brand' : 'text-slate-700 hover:bg-slate-100'}`}>
            <Users size={16} /> All accounts
          </button>
          {accounts.data?.map((a) => (
            <button key={a.id} onClick={() => setParam('account', a.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm ${accountId === a.id ? 'bg-blue-50 font-semibold text-brand' : 'text-slate-700 hover:bg-slate-100'}`}>
              <Avatar name={a.displayName ?? a.label} src={a.avatarUrl} size={22} />
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              <StatusDot status={a.status} />
              {!!a.unread && <span className="text-xs text-slate-500">{a.unread}</span>}
            </button>
          ))}
          {accounts.data?.length === 0 && (
            <Link to="/accounts" className="mx-3 mt-2 block rounded-md border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500 hover:border-brand hover:text-brand">
              Connect your first LinkedIn account
            </Link>
          )}
        </div>
      </aside>

      {/* Conversation list */}
      <section className={`w-full shrink-0 flex-col border-r border-slate-200 bg-white md:flex md:w-[360px] ${conversationId ? 'hidden' : 'flex'}`}>
        <div className="border-b border-slate-200 p-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
            <input className="input pl-9" placeholder="Search messages and people" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="input mt-2 lg:hidden" value={accountId} onChange={(e) => setParam('account', e.target.value)}>
            <option value="">All accounts</option>
            {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.isLoading && <div className="p-4 text-sm text-slate-500">Loading…</div>}
          {!list.isLoading && conversations.length === 0 && (
            <Empty icon={<MessagesSquare size={36} />} title="No conversations">
              {accounts.data?.length ? 'New LinkedIn messages will show up here in real time.' : 'Connect a LinkedIn account to get started.'}
            </Empty>
          )}
          {conversations.map((c) => <ConversationRow key={c.id} c={c} active={c.id === conversationId} search={params.toString()} />)}
          {list.hasNextPage && (
            <button onClick={() => list.fetchNextPage()} disabled={list.isFetchingNextPage} className="w-full py-3 text-sm font-semibold text-brand hover:bg-slate-50">
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </section>

      {/* Thread */}
      <section className={`min-w-0 flex-1 bg-white ${conversationId ? 'flex' : 'hidden md:flex'}`}>
        {conversationId ? <Thread key={conversationId} conversationId={conversationId} /> : (
          <Empty icon={<MessagesSquare size={44} />} title="Select a conversation">Messages from all connected LinkedIn accounts appear here.</Empty>
        )}
      </section>
    </div>
  );
}

function ConversationRow({ c, active, search }: { c: Conversation; active: boolean; search: string }) {
  const nav = useNavigate();
  const p = c.participants?.[0];
  const locked = c.lockedByName && c.lockedUntil && new Date(c.lockedUntil) > new Date();
  return (
    <button onClick={() => nav(`/inbox/${c.id}${search ? `?${search}` : ''}`)}
      className={`flex w-full gap-3 border-b border-slate-100 px-3 py-3 text-left ${active ? 'border-l-4 border-l-brand bg-blue-50/60' : 'hover:bg-slate-50'}`}>
      <div className="relative">
        {c.isGroup && !p?.avatarUrl ? (
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-slate-600"><Users size={20} /></div>
        ) : <Avatar name={p?.name ?? conversationTitle(c)} src={p?.avatarUrl} size={48} />}
        <span className="absolute -bottom-1 -right-1 rounded-full bg-white p-0.5" title={`via ${c.accountLabel}`}>
          <Avatar name={c.accountName ?? c.accountLabel} src={c.accountAvatar} size={18} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={`truncate text-sm ${c.unreadCount ? 'font-bold' : 'font-semibold'}`}>{conversationTitle(c)}</span>
          <span className="ml-auto shrink-0 text-xs text-slate-500">{timeAgo(c.lastMessageAt)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-sm ${c.unreadCount ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>
            {c.lastMessageFromSelf ? 'You: ' : ''}{c.lastMessagePreview ?? ''}
          </span>
          {c.unreadCount > 0 && <span className="ml-auto shrink-0 rounded-full bg-brand px-1.5 text-[11px] font-semibold leading-5 text-white">{c.unreadCount}</span>}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
          <span className="truncate rounded bg-slate-100 px-1.5 py-0.5">{c.accountLabel}</span>
          {c.isStarred && <Star size={12} className="fill-amber-400 text-amber-400" />}
          {c.assignedToName && <span className="truncate">→ {c.assignedToName}</span>}
          {locked && <span className="flex items-center gap-1 text-amber-700"><Lock size={11} /> {c.lockedByName} replying</span>}
        </div>
      </div>
    </button>
  );
}
