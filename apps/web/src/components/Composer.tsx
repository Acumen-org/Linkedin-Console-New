import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Paperclip, Send, X, Lock, Loader2 } from 'lucide-react';
import { api } from '../api';
import type { Conversation, Message } from '../types';
import { useMe } from '../App';
import { getSocket } from '../realtime';
import { toast } from '../toast';
import { formatBytes } from '../util';

type Upload = { id: string; name: string; mime: string; size: number };

export function Composer({ conversation, disabledReason }: { conversation: Conversation; disabledReason: string | null }) {
  const me = useMe();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lockTimer = useRef<number>(0);
  const lastLock = useRef(0);
  const lockedByOther = !!conversation.lockedBy && conversation.lockedBy !== me.id && !!conversation.lockedUntil && new Date(conversation.lockedUntil) > new Date();
  const disabled = !!disabledReason || lockedByOther;

  // Claim the conversation while typing, so teammates don't reply at the same time.
  const touch = () => {
    if (Date.now() - lastLock.current > 60_000) {
      lastLock.current = Date.now();
      api.post(`/api/conversations/${conversation.id}/lock`).catch((e) => toast(e.message, 'error'));
      getSocket()?.emit('composing', { conversationId: conversation.id, active: true });
    }
    window.clearTimeout(lockTimer.current);
    lockTimer.current = window.setTimeout(release, 20_000);
  };
  const release = () => {
    if (!lastLock.current) return;
    lastLock.current = 0;
    api.del(`/api/conversations/${conversation.id}/lock`).catch(() => {});
    getSocket()?.emit('composing', { conversationId: conversation.id, active: false });
  };
  useEffect(() => () => { window.clearTimeout(lockTimer.current); release(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [text]);

  const addFiles = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 5 - uploads.length)) {
      if (f.size > 20 * 1024 * 1024) { toast(`${f.name} is larger than 20 MB`, 'error'); continue; }
      setUploading((n) => n + 1);
      try {
        const u = await api.upload<Upload>('/api/uploads', f);
        setUploads((list) => [...list, u]);
        touch();
      } catch (e) {
        toast((e as Error).message, 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && !uploads.length) || sending || uploading || disabled) return;
    const clientId = crypto.randomUUID();
    const optimistic: Message = {
      id: `tmp-${clientId}`, conversationId: conversation.id, messageUrn: null, clientId, direction: 'OUTBOUND', senderUrn: null,
      senderName: null, senderAvatarUrl: null, sentByUserId: me.id, sentByName: me.name, text: body,
      attachments: uploads.map((u) => ({ kind: u.mime.startsWith('image/') ? 'image' : 'file', name: u.name, mime: u.mime, size: u.size, uploadId: u.id })),
      reactions: [], status: 'QUEUED', error: null, deleted: false, seenAt: null, sentAt: new Date().toISOString(),
    };
    qc.setQueryData<Message[]>(['messages', conversation.id], (list) => [...(list ?? []), optimistic]);
    setSending(true);
    try {
      const saved = await api.post<Message>(`/api/conversations/${conversation.id}/messages`, { text: body, uploadIds: uploads.map((u) => u.id), clientId });
      qc.setQueryData<Message[]>(['messages', conversation.id], (list) => list?.map((m) => (m.clientId === clientId ? { ...m, ...saved } : m)));
      setText('');
      setUploads([]);
      lastLock.current = 0;
    } catch (e) {
      qc.setQueryData<Message[]>(['messages', conversation.id], (list) => list?.filter((m) => m.clientId !== clientId));
      toast((e as Error).message, 'error');
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  };

  if (disabledReason) {
    return <div className="border-t border-slate-200 bg-slate-50 px-4 py-3 text-center text-sm text-slate-500">{disabledReason}</div>;
  }

  return (
    <div className="border-t border-slate-200 p-3">
      {lockedByOther && (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <Lock size={14} /> {conversation.lockedByName ?? 'A teammate'} is replying to this conversation right now.
        </div>
      )}
      {(uploads.length > 0 || uploading > 0) && (
        <div className="mb-2 flex flex-wrap gap-2">
          {uploads.map((u) => (
            <span key={u.id} className="flex items-center gap-1 rounded-md bg-slate-100 px-2 py-1 text-xs">
              <Paperclip size={12} /> {u.name} <span className="text-slate-500">{formatBytes(u.size)}</span>
              <button onClick={() => setUploads((l) => l.filter((x) => x.id !== u.id))}><X size={12} /></button>
            </span>
          ))}
          {uploading > 0 && <span className="flex items-center gap-1 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Uploading…</span>}
        </div>
      )}
      <div className="flex items-end gap-2">
        <button onClick={() => fileRef.current?.click()} disabled={disabled || uploads.length >= 5} className="btn-ghost px-2 py-2" title="Attach image or file">
          <Paperclip size={20} />
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? 'Locked' : 'Write a message…  (Enter to send, Shift+Enter for a new line)'}
          onChange={(e) => { setText(e.target.value); touch(); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
          className="input min-h-[40px] resize-none rounded-2xl py-2.5"
        />
        <button onClick={send} disabled={disabled || sending || uploading > 0 || (!text.trim() && !uploads.length)} className="btn-primary h-10 w-10 rounded-full p-0" title="Send">
          {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
        </button>
      </div>
    </div>
  );
}
