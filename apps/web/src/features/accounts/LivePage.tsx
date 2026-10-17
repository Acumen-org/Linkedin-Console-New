import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Lock } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Account } from '../../types';

/** The real LinkedIn website of an account, streamed from its browser on the server. */
export function LivePage() {
  const { accountId } = useParams();
  const account = useQuery({ queryKey: ['account', accountId], queryFn: () => api.get<Account>(`/api/accounts/${accountId}`) });
  const gate = useQuery({
    queryKey: ['live-unlock', accountId],
    queryFn: () => api.get<{ hasCredentials: boolean; unlocked: boolean }>(`/api/accounts/${accountId}/live-unlock`),
  });
  const [unlocked, setUnlocked] = useState(false);
  const a = account.data;
  if (account.isError) return <div className="p-6 text-sm text-red-600">Account not found or no access.</div>;
  if (!a || gate.isLoading) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  const locked = !!gate.data?.hasCredentials && !gate.data.unlocked && !unlocked;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <Link to="/accounts" className="btn-ghost px-2">
          <ArrowLeft size={18} />
        </Link>
        <span className="font-semibold">Live LinkedIn · {a.label}</span>
        <StatusBadge status={a.status} />
        <span className="ml-auto text-xs text-slate-500">
          {a.level === 'FULL' ? 'Everyone with access sees the same screen; one person controls at a time.' : 'View only'}
        </span>
      </div>
      {locked ? (
        <UnlockForm accountId={a.id} onUnlocked={() => setUnlocked(true)} />
      ) : (
        <iframe
          title="Live LinkedIn"
          src={`/live/${a.id}/`}
          className="min-h-0 w-full flex-1 border-0 bg-slate-200"
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}

function UnlockForm({ accountId, onUnlocked }: { accountId: string; onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/accounts/${accountId}/live-unlock`, { password });
      onUnlocked();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-1 items-center justify-center bg-slate-50 p-6">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2 font-semibold">
          <Lock size={18} /> Enter the LinkedIn password
        </div>
        <p className="text-sm text-slate-600">
          Opening the real LinkedIn session needs this account's LinkedIn password. You won't be asked again for a while.
        </p>
        <input
          className="input"
          type="password"
          autoFocus
          autoComplete="off"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="LinkedIn password"
        />
        <button className="btn-primary w-full" type="submit" disabled={!password || busy}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
