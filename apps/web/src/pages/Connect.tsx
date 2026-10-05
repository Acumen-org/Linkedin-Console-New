import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { api } from '../api';
import type { Account } from '../types';
import { StatusBadge } from '../components/ui';
import { toast } from '../toast';

/** The teammate logs in to LinkedIn (incl. 2FA/captcha) inside the live browser window. */
export function ConnectPage() {
  const { accountId } = useParams();
  const nav = useNavigate();
  const account = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => api.get<Account>(`/api/accounts/${accountId}`),
    refetchInterval: 3000,
  });
  const a = account.data;

  useEffect(() => {
    if (a?.status === 'CONNECTED') {
      toast(`${a.displayName ?? a.label} is connected. Syncing conversations…`, 'success');
      const t = setTimeout(() => nav(`/inbox?account=${a.id}`), 2500);
      return () => clearTimeout(t);
    }
  }, [a?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (account.isError) return <div className="p-6 text-sm text-red-600">Account not found.</div>;
  if (!a) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
  const ready = a.status !== 'PROVISIONING' && a.status !== 'ERROR' && a.status !== 'OFFLINE';

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <Link to="/accounts" className="btn-ghost px-2"><ArrowLeft size={18} /></Link>
        <div className="flex-1">
          <div className="flex items-center gap-2 font-semibold">Log in to LinkedIn · {a.label} <StatusBadge status={a.status} /></div>
          <div className="text-xs text-slate-500">
            Click into the window below, sign in with email + password and finish 2FA. This window is the account's own browser on your server.
          </div>
        </div>
        {a.status === 'CONNECTED' && <span className="flex items-center gap-1 text-sm font-semibold text-emerald-700"><CheckCircle2 size={18} /> Connected as {a.displayName}</span>}
      </div>
      {a.status === 'NEEDS_ATTENTION' && (
        <div className="flex items-center gap-2 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          <ShieldAlert size={16} /> LinkedIn logged this account out or asked for a security check. Sending is paused until you finish it here.
        </div>
      )}
      <div className="min-h-0 flex-1 bg-slate-200">
        {ready ? (
          <iframe title="LinkedIn login" src={`/live/${a.id}/`} className="h-full w-full border-0" allow="clipboard-read; clipboard-write" />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-600">
            {a.status === 'ERROR' || a.status === 'OFFLINE' ? (
              <>
                <ShieldAlert size={32} className="text-red-500" />
                <div>The account's browser isn't running. {a.lastError}</div>
                <button className="btn-primary" onClick={() => api.post(`/api/accounts/${a.id}/restart`).then(() => toast('Restarting…'))}>Restart browser</button>
              </>
            ) : (
              <><Loader2 className="animate-spin" size={32} /> Starting a secure browser for this account…</>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
