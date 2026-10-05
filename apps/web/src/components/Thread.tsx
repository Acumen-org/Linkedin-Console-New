import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Star, Archive, ArchiveRestore, StickyNote, MonitorPlay, RefreshCw, Users, Send } from 'lucide-react';
import { api } from '../api';
import type { Conversation, Message, Note, User } from '../types';
import { useMe } from '../App';
import { onRealtime } from '../realtime';
import { toast } from '../toast';
import { Avatar } from './ui';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';
import { conversationTitle, dayLabel, timeAgo } from '../util';

export function Thread({ conversationId }: { conversationId: string }) {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [showNotes, setShowNotes] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [typing, setTyping] = useState<Record<string, number>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const conv = useQuery({ queryKey: ['conversation', conversationId], queryFn: () => api.get<Conversation>(`/api/conversations/${conversationId}`) });
  const messages = useQuery({ queryKey: ['messages', conversationId], queryFn: () => api.get<Message[]>(`/api/conversations/${conversationId}/messages`) });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') });
  const c = conv.data;

  // Opening an unread conversation marks it read (also on LinkedIn).
  useEffect(() => {
    if (c && c.unreadCount > 0) api.post(`/api/conversations/${c.id}/read`).catch(() => {});
  }, [c?.id, c?.unreadCount]); // eslint-disable-line react-hooks/exhaustive-deps

  // LinkedIn typing + teammates composing.
  useEffect(() => onRealtime(({ type, data }) => {
    if (data?.conversationId !== conversationId) return;
    if (type === 'linkedin.typing') setTyping((t) => ({ ...t, [`li:${data.name}`]: Date.now() + 6000 }));
    if (type === 'team.composing') setTyping((t) => ({ ...t, [`team:${data.name}`]: data.active ? Date.now() + 25_000 : 0 }));
    if (type === 'message' && data.direction === 'INBOUND') setTyping((t) => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith('li:'))));
  }), [conversationId]);
  useEffect(() => { const i = setInterval(() => setTyping((t) => ({ ...t })), 2000); return () => clearInterval(i); }, []);
  const typingNow = Object.entries(typing).filter(([, until]) => until > Date.now()).map(([k]) => k);

  // Keep scrolled to the bottom unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.data, typingNow.length]);

  const loadOlder = async () => {
    const first = messages.data?.[0];
    if (!first) return;
    setLoadingOlder(true);
    try {
      const older = await api.get<Message[]>(`/api/conversations/${conversationId}/messages?before=${encodeURIComponent(first.sentAt)}`);
      if (older.length === 0) {
        setNoMore(true);
        await api.post(`/api/conversations/${conversationId}/sync`);
        toast('Fetching older messages from LinkedIn…');
      }
      const el = scrollRef.current;
      const prevHeight = el?.scrollHeight ?? 0;
      stickToBottom.current = false;
      qc.setQueryData<Message[]>(['messages', conversationId], (list) => [...older, ...(list ?? [])]);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prevHeight; });
    } finally {
      setLoadingOlder(false);
    }
  };

  const patch = async (body: Partial<Conversation>) => {
    try {
      const updated = await api.patch<Conversation>(`/api/conversations/${conversationId}`, body);
      qc.setQueryData(['conversation', conversationId], (old: Conversation | undefined) => ({ ...old, ...updated }));
      qc.invalidateQueries({ queryKey: ['conversations'] });
    } catch (e) { toast((e as Error).message, 'error'); }
  };

  const lastOutboundId = useMemo(() => [...(messages.data ?? [])].reverse().find((m) => m.direction === 'OUTBOUND')?.id, [messages.data]);

  if (conv.isError) return <div className="m-auto text-sm text-slate-500">Conversation not found.</div>;
  if (!c) return <div className="m-auto text-sm text-slate-500">Loading…</div>;

  const canReply = c.level === 'REPLY' || c.level === 'FULL';
  const disabledReason = !canReply ? 'You have read-only access to this account.'
    : c.accountStatus !== 'CONNECTED' ? `${c.accountLabel} is not connected right now, so messages can't be sent.`
    : !c.threadId ? 'This conversation is still syncing.' : null;
  const main = c.participants[0];

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5">
          <button onClick={() => nav('/inbox')} className="btn-ghost px-1 md:hidden"><ArrowLeft size={20} /></button>
          {c.isGroup ? <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-200"><Users size={18} /></div>
            : <Avatar name={main?.name ?? conversationTitle(c)} src={main?.avatarUrl} size={40} />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {main?.profileUrl && !c.isGroup
                ? <a href={main.profileUrl} target="_blank" rel="noreferrer" className="truncate font-semibold hover:underline">{conversationTitle(c)}</a>
                : <span className="truncate font-semibold">{conversationTitle(c)}</span>}
            </div>
            <div className="truncate text-xs text-slate-500">
              {c.isGroup ? `${c.participants.length + 1} people` : main?.headline}
              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">via {c.accountLabel}</span>
            </div>
          </div>
          <select value={c.assignedTo ?? ''} onChange={(e) => patch({ assignedTo: e.target.value || null })} disabled={!canReply}
            className="hidden rounded-md border border-slate-200 px-2 py-1 text-xs xl:block" title="Assign to teammate">
            <option value="">Unassigned</option>
            {users.data?.filter((u) => !u.disabledAt).map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? 'Me' : u.name}</option>)}
          </select>
          <button onClick={() => patch({ isStarred: !c.isStarred })} className="btn-ghost px-2" title="Star"><Star size={18} className={c.isStarred ? 'fill-amber-400 text-amber-400' : ''} /></button>
          <button onClick={() => patch({ isArchived: !c.isArchived })} className="btn-ghost px-2" title={c.isArchived ? 'Unarchive' : 'Archive (in this app)'}>
            {c.isArchived ? <ArchiveRestore size={18} /> : <Archive size={18} />}
          </button>
          <button onClick={() => setShowNotes((s) => !s)} className={`btn-ghost px-2 ${showNotes ? 'bg-blue-50 text-brand' : ''}`} title="Team notes"><StickyNote size={18} /></button>
          {c.level === 'FULL' && <Link to={`/accounts/${c.accountId}/live`} className="btn-ghost px-2" title="Open Live LinkedIn"><MonitorPlay size={18} /></Link>}
        </div>

        {/* Messages */}
        <div ref={scrollRef} onScroll={(e) => { const el = e.currentTarget; stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
          className="flex-1 overflow-y-auto px-4 py-3">
          {messages.data && messages.data.length >= 60 && !noMore && (
            <div className="mb-2 text-center">
              <button onClick={loadOlder} disabled={loadingOlder} className="btn-ghost text-xs">{loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>
            </div>
          )}
          {messages.data && messages.data.length < 60 && (
            <div className="mb-2 text-center">
              <button onClick={async () => { await api.post(`/api/conversations/${conversationId}/sync`); toast('Fetching history from LinkedIn…'); }} className="btn-ghost text-xs">
                <RefreshCw size={12} /> Fetch older history from LinkedIn
              </button>
            </div>
          )}
          {messages.isLoading && <div className="text-center text-sm text-slate-500">Loading messages…</div>}
          {messages.data?.map((m, i, arr) => {
            const prev = arr[i - 1];
            const newDay = !prev || new Date(prev.sentAt).toDateString() !== new Date(m.sentAt).toDateString();
            const showSender = newDay || !prev || prev.direction !== m.direction || prev.senderUrn !== m.senderUrn || new Date(m.sentAt).getTime() - new Date(prev.sentAt).getTime() > 5 * 60_000;
            return (
              <Fragment key={m.id}>
                {newDay && <div className="my-4 flex items-center gap-3 text-xs font-semibold text-slate-500"><div className="h-px flex-1 bg-slate-200" />{dayLabel(m.sentAt)}<div className="h-px flex-1 bg-slate-200" /></div>}
                <MessageBubble m={m} showSender={showSender} isLastOutbound={m.id === lastOutboundId} />
              </Fragment>
            );
          })}
          {messages.data?.length === 0 && <div className="mt-10 text-center text-sm text-slate-500">No messages synced yet.</div>}
          {typingNow.length > 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
              <span className="flex gap-0.5"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:150ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400 [animation-delay:300ms]" /></span>
              {typingNow.map((k) => k.startsWith('li:') ? `${k.slice(3)} is typing` : `${k.slice(5)} (team) is replying`).join(' · ')}
            </div>
          )}
        </div>

        <Composer conversation={c} disabledReason={disabledReason} />
      </div>
      {showNotes && <NotesPanel conversationId={conversationId} onClose={() => setShowNotes(false)} />}
    </div>
  );
}

function NotesPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const qc = useQueryClient();
  const notes = useQuery({ queryKey: ['notes', conversationId], queryFn: () => api.get<Note[]>(`/api/conversations/${conversationId}/notes`) });
  const add = async () => {
    if (!text.trim()) return;
    try {
      const n = await api.post<Note>(`/api/conversations/${conversationId}/notes`, { text: text.trim() });
      qc.setQueryData<Note[]>(['notes', conversationId], (l) => (l && !l.some((x) => x.id === n.id) ? [...l, n] : l));
      setText('');
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-slate-200 bg-amber-50/40">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <span className="text-sm font-semibold">Team notes</span>
        <button onClick={onClose} className="text-xs text-slate-500 hover:underline">Close</button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {notes.data?.length === 0 && <div className="text-xs text-slate-500">Notes are only visible to your team, never sent to LinkedIn.</div>}
        {notes.data?.map((n) => (
          <div key={n.id} className="rounded-lg bg-white p-2.5 text-sm shadow-sm">
            <div className="whitespace-pre-wrap">{n.text}</div>
            <div className="mt-1 text-[11px] text-slate-500">{n.userName} · {timeAgo(n.createdAt)}</div>
          </div>
        ))}
      </div>
      <div className="flex gap-2 border-t border-slate-200 p-3">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Add a note…" className="input resize-none text-sm"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } }} />
        <button onClick={add} className="btn-primary self-end px-3"><Send size={14} /></button>
      </div>
    </aside>
  );
}
