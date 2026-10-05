import { BookmarkPlus, MessageSquareText, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useMe } from '../../App';
import { Popover } from '../../components/ui';
import { api } from '../../lib/api';
import { useAppConfig, useTemplates } from '../../lib/queries';
import { toast } from '../../lib/toast';
import type { Conversation } from '../../types';

/** Fills {firstName}, {name}, {myName}, {myFirstName}, {account} in a saved reply. */
export function fillTemplate(body: string, conversation: Conversation, myName: string) {
  const contact = conversation.participants[0]?.name ?? '';
  const vars: Record<string, string> = {
    firstName: contact.split(' ')[0] ?? '',
    name: contact,
    myName,
    myFirstName: myName.split(' ')[0] ?? '',
    account: conversation.accountName ?? conversation.accountLabel,
  };
  return body.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
}

export function TemplatePicker({
  conversation,
  onInsert,
  currentText,
}: {
  conversation: Conversation;
  onInsert: (text: string) => void;
  currentText: string;
}) {
  const me = useMe();
  const templates = useTemplates();
  const [q, setQ] = useState('');
  const list = (templates.data ?? []).filter((t) => `${t.title} ${t.body}`.toLowerCase().includes(q.toLowerCase()));

  const saveCurrent = async () => {
    const title = prompt('Name for this saved reply');
    if (!title?.trim()) return;
    try {
      await api.post('/api/templates', { title, body: currentText, shared: true });
      await templates.refetch();
      toast('Saved reply created', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Popover
      align="left"
      side="top"
      width={320}
      trigger={({ toggle }) => (
        <button onClick={toggle} className="btn-ghost px-2 py-2" title="Saved replies">
          <MessageSquareText size={20} />
        </button>
      )}
    >
      {(close) => (
        <div className="space-y-1">
          <input
            autoFocus
            className="input py-1.5 text-sm"
            placeholder="Search saved replies"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="max-h-72 overflow-y-auto">
            {list.map((t) => (
              <button
                key={t.id}
                onClick={() => {
                  onInsert(fillTemplate(t.body, conversation, me.name));
                  close();
                }}
                className="block w-full rounded px-2 py-1.5 text-left hover:bg-slate-100"
              >
                <div className="text-sm font-semibold">{t.title}</div>
                <div className="truncate text-xs text-slate-500">{t.body}</div>
              </button>
            ))}
            {list.length === 0 && <div className="px-2 py-2 text-xs text-slate-500">No saved replies{q ? ' match' : ' yet'}.</div>}
          </div>
          <div className="flex items-center justify-between border-t border-slate-100 px-1 pt-1">
            <button
              disabled={!currentText.trim()}
              onClick={saveCurrent}
              className="btn-ghost px-2 text-xs"
              title="Save the current text as a reply"
            >
              <BookmarkPlus size={14} /> Save current
            </button>
            <Link to="/settings/templates" className="text-xs text-brand hover:underline">
              Manage
            </Link>
          </div>
        </div>
      )}
    </Popover>
  );
}

export function AiDraftButton({
  conversationId,
  onDraft,
  disabled,
}: {
  conversationId: string;
  onDraft: (text: string) => void;
  disabled?: boolean;
}) {
  const config = useAppConfig();
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  if (!config.data?.features.aiDrafts) return null;

  const draft = async (close: () => void) => {
    setBusy(true);
    try {
      const { draft } = await api.post<{ draft: string }>(`/api/conversations/${conversationId}/draft`, {
        instruction: instruction || undefined,
      });
      onDraft(draft);
      setInstruction('');
      close();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popover
      align="left"
      side="top"
      width={300}
      trigger={({ toggle }) => (
        <button onClick={toggle} disabled={disabled} className="btn-ghost px-2 py-2 text-violet-600" title="Draft a reply with AI">
          <Sparkles size={20} />
        </button>
      )}
    >
      {(close) => (
        <div className="space-y-2 p-1">
          <div className="text-xs font-semibold text-slate-600">Draft a reply with AI</div>
          <input
            className="input py-1.5 text-sm"
            placeholder="Optional: e.g. propose a call on Thursday"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && draft(close)}
          />
          <button onClick={() => draft(close)} disabled={busy} className="btn-primary w-full">
            {busy ? 'Drafting…' : 'Write draft'}
          </button>
          <div className="text-[11px] text-slate-500">The draft goes into the message box. You review and send it yourself.</div>
        </div>
      )}
    </Popover>
  );
}
