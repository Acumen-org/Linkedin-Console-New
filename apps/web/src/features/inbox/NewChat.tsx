import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Avatar } from '../../components/ui';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Account, Contact } from '../../types';

interface Lookup {
  contact: Contact;
  conversationId: string | null;
}

/** How long to wait for LinkedIn's copy of the first message before telling the user it is slow. */
const SLOW_MS = 90_000;

/**
 * A first message to a connection, in the inbox. Once LinkedIn confirms it, the new conversation opens in its
 * place; if a chat with them already exists, that one opens straight away.
 */
export function NewChat({ accountId, contactId }: { accountId: string; contactId: string }) {
  const nav = useNavigate();
  const [text, setText] = useState('');
  const [sent, setSent] = useState<{ text: string; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const account = accounts.data?.find((a) => a.id === accountId);
  const lookup = useQuery({
    queryKey: ['new-chat', accountId, contactId],
    queryFn: () => api.get<Lookup>(`/api/accounts/${accountId}/connections/${contactId}`),
    // After sending: watch for the conversation LinkedIn creates.
    refetchInterval: sent ? 2000 : false,
  });
  const conversationId = lookup.data?.conversationId;
  const contact = lookup.data?.contact;

  useEffect(() => {
    if (conversationId) nav(`/inbox/${conversationId}?account=${accountId}`, { replace: true });
  }, [conversationId, accountId, nav]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resize the textarea whenever the text changes
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const send = async () => {
    const body = text.trim();
    if (!body || busy || sent) return;
    setBusy(true);
    try {
      await api.post(`/api/accounts/${accountId}/connections/${contactId}/message`, { text: body });
      setSent({ text: body, at: Date.now() });
      setText('');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const slow = sent && Date.now() - sent.at > SLOW_MS;
  const canSend = account && account.level !== 'READ';

  if (lookup.isError) {
    return <div className="m-auto p-6 text-sm text-slate-500">This connection is no longer available.</div>;
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-2.5">
        <button onClick={() => nav('/inbox')} className="btn-ghost px-1 md:hidden">
          <ArrowLeft size={20} />
        </button>
        <Avatar name={contact?.name ?? '…'} src={contact?.avatarUrl} size={40} />
        <div className="min-w-0 flex-1">
          {contact?.profileUrl ? (
            <a href={contact.profileUrl} target="_blank" rel="noreferrer" className="truncate font-semibold hover:underline">
              {contact.name}
            </a>
          ) : (
            <span className="truncate font-semibold">{contact?.name ?? 'Loading…'}</span>
          )}
          <div className="truncate text-xs text-slate-500">
            {contact?.headline}
            {account && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">via {account.label}</span>}
          </div>
        </div>
        <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-brand">New conversation</span>
      </div>

      <div className="flex flex-1 flex-col justify-end overflow-y-auto px-4 py-3">
        {sent ? (
          <div className="flex flex-col items-end">
            <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-brand px-3.5 py-2 text-sm text-white opacity-80">
              {sent.text}
            </div>
            <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
              <Loader2 size={12} className="animate-spin" />
              {slow
                ? 'Still waiting for LinkedIn. The conversation will open here once it is confirmed.'
                : 'Sending through LinkedIn… the conversation opens here once it is confirmed.'}
            </div>
          </div>
        ) : (
          <div className="m-auto max-w-sm text-center text-sm text-slate-500">
            No messages with {contact?.name ?? 'this connection'} yet. Your first message starts the conversation on LinkedIn.
          </div>
        )}
      </div>

      {canSend && !sent && (
        <div className="border-t border-slate-200 p-3">
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              autoFocus
              placeholder="Write a message…  (Enter to send, Shift+Enter for a new line)"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              className="input min-h-[40px] resize-none rounded-2xl py-2.5"
            />
            <button onClick={send} disabled={busy || !text.trim()} className="btn-primary h-10 w-10 rounded-full p-0" title="Send">
              {busy ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
