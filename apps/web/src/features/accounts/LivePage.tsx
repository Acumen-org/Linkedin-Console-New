import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import type { Account } from '../../types';

/** The real LinkedIn website of an account, streamed from its browser on the server. */
export function LivePage() {
  const { accountId } = useParams();
  const account = useQuery({ queryKey: ['account', accountId], queryFn: () => api.get<Account>(`/api/accounts/${accountId}`) });
  const a = account.data;
  if (account.isError) return <div className="p-6 text-sm text-red-600">Account not found or no access.</div>;
  if (!a) return <div className="p-6 text-sm text-slate-500">Loading…</div>;
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
      <iframe
        title="Live LinkedIn"
        src={`/live/${a.id}/`}
        className="min-h-0 w-full flex-1 border-0 bg-slate-200"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  );
}
