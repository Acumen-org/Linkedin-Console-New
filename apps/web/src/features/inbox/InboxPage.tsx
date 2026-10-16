import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  Archive,
  BellRing,
  Hourglass,
  Inbox as InboxIcon,
  Layers,
  Link2,
  Lock,
  Mail,
  MessagesSquare,
  Plus,
  Reply,
  Search,
  SendHorizontal,
  Star,
  Tag,
  UserCheck,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Avatar, Empty, LabelChip, StatusDot } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { conversationTitle, timeAgo } from '../../lib/format';
import { useAppConfig, useLabels } from '../../lib/queries';
import type { Account, Conversation } from '../../types';
import { isSyncing, SyncProgress } from '../accounts/SyncProgress';
import { isOverdue } from './ConversationActions';
import { NewChat } from './NewChat';
import { Thread } from './Thread';

const VIEWS = [
  { id: 'all', label: 'All', icon: InboxIcon },
  { id: 'replied', label: 'Replied', icon: Reply },
  { id: 'no_reply', label: 'No reply yet', icon: SendHorizontal },
  { id: 'followups', label: 'Follow-ups', icon: BellRing },
  { id: 'crm_needed', label: 'Needs CRM binding', icon: Link2 },
  { id: 'unread', label: 'Unread', icon: Mail },
  { id: 'awaiting', label: 'Awaiting reply', icon: Hourglass },
  { id: 'starred', label: 'Starred', icon: Star },
  { id: 'mine', label: 'Assigned to me', icon: UserCheck },
  { id: 'snoozed', label: 'Snoozed', icon: AlarmClock },
  { id: 'other', label: 'Other', icon: Layers },
  { id: 'requests', label: 'Requests & InMail', icon: MessagesSquare },
  { id: 'archived', label: 'Archived', icon: Archive },
] as const;

export function InboxPage() {
  const { conversationId } = useParams();
  const [params, setParams] = useSearchParams();
  const accountId = params.get('account') ?? '';
  const view = params.get('view') ?? 'all';
  const labelId = params.get('label') ?? '';
  // Message from the Network page: a first message to a connection (?account=…&newChat=<contactId>).
  const newChat = !conversationId && accountId ? params.get('newChat') : null;
  const threadOpen = !!conversationId || !!newChat;
  const labels = useLabels();
  const appConfig = useAppConfig();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [q, setQ] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const totalUnread = accounts.data?.reduce((n, a) => n + (a.unread ?? 0), 0) ?? 0;

  const list = useInfiniteQuery({
    queryKey: ['conversations', accountId, view, labelId, q],
    queryFn: ({ pageParam }) =>
      api.get<Conversation[]>(
        `/api/conversations${qs({ accountId, view, labelId, q, before: pageParam?.before, beforeId: pageParam?.id })}`,
      ),
    initialPageParam: undefined as { before: string | null; id: string } | undefined,
    // Cursor = the last row's time and id, so rows sharing a time at the page edge aren't skipped.
    getNextPageParam: (last) => {
      const row = last[last.length - 1];
      return last.length === 40 && row ? { before: row.lastMessageAt ?? null, id: row.id } : undefined;
    },
  });
  const conversations = useMemo(() => list.data?.pages.flat() ?? [], [list.data]);

  return (
    <div className="flex h-full">
      {/* Accounts + views */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white lg:flex">
        <div className="border-b border-slate-200 px-4 py-3 text-sm font-semibold">Inbox</div>
        <div className="flex-1 overflow-y-auto p-2">
          {VIEWS.filter((v) => v.id !== 'crm_needed' || !!appConfig.data?.twentyUrl).map((v) => (
            <button
              key={v.id}
              onClick={() => setParam('view', v.id === 'all' ? '' : v.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm ${view === v.id ? 'bg-blue-50 font-semibold text-brand' : 'text-slate-700 hover:bg-slate-100'}`}
            >
              <v.icon size={16} /> {v.label}
              {v.id === 'unread' && totalUnread > 0 && <span className="ml-auto text-xs text-slate-500">{totalUnread}</span>}
            </button>
          ))}
          <div className="mb-1 mt-4 flex items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            LinkedIn accounts
            <Link to="/accounts" title="Connect an account" className="text-brand">
              <Plus size={16} />
            </Link>
          </div>
          <button
            onClick={() => setParam('account', '')}
            className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm ${!accountId ? 'bg-blue-50 font-semibold text-brand' : 'text-slate-700 hover:bg-slate-100'}`}
          >
            <Users size={16} /> All accounts
          </button>
          {accounts.data?.map((a) => (
            <button
              key={a.id}
              onClick={() => setParam('account', a.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm ${accountId === a.id ? 'bg-blue-50 font-semibold text-brand' : 'text-slate-700 hover:bg-slate-100'}`}
            >
              <Avatar name={a.displayName ?? a.label} src={a.avatarUrl} size={22} />
              <span className="min-w-0 flex-1 truncate">
                {a.label}
                {isSyncing(a.sync) && <SyncProgress sync={a.sync} compact />}
              </span>
              <StatusDot status={a.status} />
              {!!a.unread && <span className="text-xs text-slate-500">{a.unread}</span>}
            </button>
          ))}
          {!!labels.data?.length && (
            <>
              <div className="mb-1 mt-4 px-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Labels</div>
              {labels.data.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setParam('label', labelId === l.id ? '' : l.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm ${labelId === l.id ? 'bg-blue-50 font-semibold text-brand' : 'text-slate-700 hover:bg-slate-100'}`}
                >
                  <Tag size={14} style={{ color: l.color }} />
                  <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  <span className="text-xs text-slate-400">{l.usage}</span>
                </button>
              ))}
            </>
          )}
          {accounts.data?.length === 0 && (
            <Link
              to="/accounts"
              className="mx-3 mt-2 block rounded-md border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500 hover:border-brand hover:text-brand"
            >
              Connect your first LinkedIn account
            </Link>
          )}
        </div>
      </aside>

      {/* Conversation list */}
      <section
        className={`w-full shrink-0 flex-col border-r border-slate-200 bg-white md:flex md:w-[360px] ${threadOpen ? 'hidden' : 'flex'}`}
      >
        <div className="border-b border-slate-200 p-3">
          <div className="relative">
            <Search size={16} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              className="input pl-9"
              placeholder="Search messages and people"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select className="input mt-2 lg:hidden" value={accountId} onChange={(e) => setParam('account', e.target.value)}>
            <option value="">All accounts</option>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.isLoading && <div className="p-4 text-sm text-slate-500">Loading…</div>}
          {!list.isLoading && conversations.length === 0 && (
            <Empty icon={<MessagesSquare size={36} />} title="No conversations">
              {accounts.data?.length
                ? 'New LinkedIn messages will show up here in real time.'
                : 'Connect a LinkedIn account to get started.'}
            </Empty>
          )}
          {conversations.map((c) => (
            <ConversationRow key={c.id} c={c} active={c.id === conversationId} search={params.toString()} />
          ))}
          {list.hasNextPage && (
            <button
              onClick={() => list.fetchNextPage()}
              disabled={list.isFetchingNextPage}
              className="w-full py-3 text-sm font-semibold text-brand hover:bg-slate-50"
            >
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </section>

      {/* Thread */}
      <section className={`min-w-0 flex-1 bg-white ${threadOpen ? 'flex' : 'hidden md:flex'}`}>
        {conversationId ? (
          <Thread key={conversationId} conversationId={conversationId} />
        ) : newChat ? (
          <NewChat key={newChat} accountId={accountId} contactId={newChat} />
        ) : (
          <Empty icon={<MessagesSquare size={44} />} title="Select a conversation">
            Messages from all connected LinkedIn accounts appear here.
          </Empty>
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
    <button
      onClick={() => nav(`/inbox/${c.id}${search ? `?${search}` : ''}`)}
      className={`flex w-full gap-3 border-b border-slate-100 px-3 py-3 text-left ${active ? 'border-l-4 border-l-brand bg-blue-50/60' : 'hover:bg-slate-50'}`}
    >
      <div className="relative">
        {c.isGroup && !p?.avatarUrl ? (
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-200 text-slate-600">
            <Users size={20} />
          </div>
        ) : (
          <Avatar name={p?.name ?? conversationTitle(c)} src={p?.avatarUrl} size={48} />
        )}
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
            {c.lastMessageFromSelf ? 'You: ' : ''}
            {c.lastMessagePreview ?? ''}
          </span>
          {c.unreadCount > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-brand px-1.5 text-[11px] font-semibold leading-5 text-white">
              {c.unreadCount}
            </span>
          )}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
          <span className="truncate rounded bg-slate-100 px-1.5 py-0.5">{c.accountLabel}</span>
          {c.labels.slice(0, 2).map((l) => (
            <LabelChip key={l.id} name={l.name} color={l.color} small />
          ))}
          {c.reminder && (
            <span
              className={`flex shrink-0 items-center gap-0.5 ${isOverdue(c.reminder.dueAt) ? 'font-semibold text-red-600' : 'text-brand'}`}
              title={c.reminder.note ?? 'Follow-up reminder'}
            >
              <BellRing size={11} />
              {new Date(c.reminder.dueAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
              {c.reminder.responsibleName ? ` · ${c.reminder.responsibleName}` : ''}
            </span>
          )}
          {c.isStarred && <Star size={12} className="fill-amber-400 text-amber-400" />}
          {c.assignedToName && <span className="truncate">→ {c.assignedToName}</span>}
          {locked && (
            <span className="flex items-center gap-1 text-amber-700">
              <Lock size={11} /> {c.lockedByName} replying
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
