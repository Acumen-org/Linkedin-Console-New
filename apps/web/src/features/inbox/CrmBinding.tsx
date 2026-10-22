import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Link2, Search, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { isAdmin, useMe } from '../../App';
import { Modal } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Conversation } from '../../types';

interface CrmState {
  binding: 'needed' | 'bound' | null;
  reason: string | null;
  personId: string | null;
  personUrl: string | null;
  personName: string | null;
  prospect: { name: string; headline: string | null; profileUrl: string | null; identified: boolean };
  owner: { field: string | null; memberId: string | null };
  pod: { field: string | null; value: string | null };
}

interface Candidate {
  id: string;
  name: string;
  jobTitle: string | null;
  company: string | null;
  city: string | null;
  email: string | null;
  linkedin: string | null;
  owner: string | null;
}

/**
 * Twenty CRM for this prospect: a reply waiting for a binding shows why and opens Bind to Twenty; admins can undo a
 * binding. Nothing shows before the prospect replies (nothing reaches Twenty then).
 */
export function CrmBindingBar({ conversation, canReply }: { conversation: Conversation; canReply: boolean }) {
  const me = useMe();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  // Everyone who can see the thread sees the binding; only admins can undo it.
  const shown = conversation.crmBinding === 'needed' || conversation.crmBinding === 'bound';
  const state = useQuery({
    queryKey: ['crm', conversation.id, conversation.crmBinding],
    queryFn: () => api.get<CrmState>(`/api/conversations/${conversation.id}/crm`),
    enabled: shown,
  });
  if (!shown || !state.data) return null;
  const s = state.data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['crm', conversation.id] });
    qc.invalidateQueries({ queryKey: ['conversation', conversation.id] });
  };

  const unbind = async () => {
    if (!confirm('Unbind this prospect from their Twenty Person? Their next messages wait until someone binds them again by hand.')) return;
    try {
      await api.post(`/api/conversations/${conversation.id}/crm/unbind`);
      toast('Unbound from Twenty', 'success');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  // Destructive, admin-only: deletes the Person AND its LinkedIn conversations from Twenty, then unbinds here.
  const unbindDelete = async () => {
    const who = state.data?.personName ?? 'this prospect’s Twenty Person';
    if (
      !confirm(
        `Permanently DELETE ${who} from Twenty?\n\n` +
          `This removes the Person and all of their LinkedIn conversation records from Twenty — this cannot be undone — then unbinds them here.\n\n` +
          `To only unbind and keep them in Twenty, use "Unbind (wrong Person)" instead.`,
      )
    )
      return;
    try {
      const r = await api.post<{ personDeleted: boolean; recordsDeleted: number; twentyError: string | null }>(
        `/api/conversations/${conversation.id}/crm/unbind-delete`,
      );
      if (r.twentyError) toast(`Unbound here, but Twenty delete failed: ${r.twentyError}`, 'error');
      else toast(r.personDeleted ? 'Deleted from Twenty and unbound' : 'Already gone from Twenty; unbound here', 'success');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  if (s.binding === 'bound') {
    const label = s.personName ? `Twenty: ${s.personName}` : 'In Twenty CRM';
    return (
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-xs text-slate-600">
        {s.personUrl ? (
          <a href={s.personUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-medium text-brand hover:underline">
            <Check size={13} /> {label}
          </a>
        ) : (
          <span className="flex items-center gap-1">
            <Check size={13} /> {label}
          </span>
        )}
        {isAdmin(me) && (
          <span className="ml-auto flex items-center gap-3">
            <button type="button" onClick={unbind} className="text-slate-500 hover:text-brand hover:underline">
              Unbind (wrong Person)
            </button>
            <button
              type="button"
              onClick={unbindDelete}
              title="Delete this Person and its LinkedIn conversations from Twenty, then unbind (irreversible)"
              className="inline-flex items-center gap-1 text-slate-400 hover:text-red-600 hover:underline"
            >
              <Trash2 size={12} /> Delete from Twenty
            </button>
          </span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
      <Link2 size={15} />
      <span className="flex-1">
        <b>Needs CRM binding.</b> They replied, so they belong in Twenty: {s.reason ?? 'not bound yet'}.
      </span>
      {canReply && (
        <button type="button" onClick={() => setOpen(true)} className="btn-primary px-3 py-1 text-xs" disabled={!s.prospect.identified}>
          Bind to Twenty
        </button>
      )}
      {open && (
        <BindModal
          conversationId={conversation.id}
          state={s}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function BindModal({
  conversationId,
  state: s,
  onClose,
  onDone,
}: {
  conversationId: string;
  state: CrmState;
  onClose: () => void;
  onDone: () => void;
}) {
  const [search, setSearch] = useState(s.prospect.name);
  const [q, setQ] = useState(s.prospect.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const candidates = useQuery({
    queryKey: ['crm-candidates', conversationId, q],
    queryFn: () => api.get<Candidate[]>(`/api/conversations/${conversationId}/crm/candidates${qs({ q })}`),
  });

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'success');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };
  const missing = [s.owner.field && !s.owner.memberId ? 'your Twenty user' : null, s.pod.field && !s.pod.value ? 'your pod' : null].filter(
    Boolean,
  );

  return (
    <Modal title={`Bind ${s.prospect.name} to Twenty`} onClose={onClose} wide>
      <p className="mb-3 text-sm text-slate-600">
        Choose the Person they are in Twenty, or add them as new. Only one Person per prospect: every conversation with them (any account,
        any teammate) then goes to it.
        {s.prospect.profileUrl && (
          <>
            {' '}
            <a href={s.prospect.profileUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
              Their LinkedIn profile
            </a>
          </>
        )}
      </p>
      <div className="relative mb-2">
        <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
        <input
          className="input pl-9"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search Twenty by name or email"
        />
      </div>
      <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
        {candidates.isLoading && <div className="p-4 text-center text-sm text-slate-500">Searching Twenty…</div>}
        {candidates.isError && <div className="p-4 text-center text-sm text-red-600">{(candidates.error as Error).message}</div>}
        {candidates.data?.length === 0 && (
          <div className="p-4 text-center text-sm text-slate-500">Nobody found: try another spelling, or add them as new.</div>
        )}
        {candidates.data?.map((p) => (
          <div key={p.id} className="flex items-center gap-3 px-3 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{p.name}</div>
              <div className="truncate text-xs text-slate-500">
                {[p.jobTitle, p.company, p.city, p.email].filter(Boolean).join(' · ') || 'No details'}
              </div>
              <div className="truncate text-xs text-slate-500">
                {p.linkedin ? (
                  <a href={p.linkedin} target="_blank" rel="noreferrer" className="hover:underline">
                    {p.linkedin}
                  </a>
                ) : (
                  'No LinkedIn link'
                )}
                {p.owner ? ` · owner ${p.owner}` : ''}
              </div>
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                act(() => api.post(`/api/conversations/${conversationId}/crm/bind`, { personId: p.id }), `Bound to ${p.name} in Twenty`)
              }
              className="btn-outline px-3 py-1 text-xs"
            >
              <Link2 size={13} /> Bind
            </button>
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md bg-slate-50 p-3 text-sm">
        <div className="min-w-0 flex-1 text-slate-600">
          Not in Twenty? Add them as a new Person
          {s.owner.field || s.pod.field ? ', owned by you' : ''}
          {s.pod.field && s.pod.value ? ` (pod ${s.pod.value})` : ''}.
          {missing.length > 0 && (
            <div className="text-xs text-amber-700">First an admin links {missing.join(' and ')} on the Team page.</div>
          )}
        </div>
        <button
          type="button"
          disabled={busy || missing.length > 0}
          onClick={() => act(() => api.post(`/api/conversations/${conversationId}/crm/add`), `${s.prospect.name} added to Twenty`)}
          className="btn-primary"
        >
          <UserPlus size={15} /> Add as new
        </button>
        {s.personUrl && (
          <a href={s.personUrl} target="_blank" rel="noreferrer" className="btn-ghost">
            <ExternalLink size={15} />
          </a>
        )}
      </div>
    </Modal>
  );
}
