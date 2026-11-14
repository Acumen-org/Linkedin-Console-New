import { useQuery } from '@tanstack/react-query';
import { Monitor, Search as SearchIcon, ShieldCheck } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { PageScroll } from '../../components/Layout';
import { Empty, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';
import type { Account } from '../../types';

/**
 * Find people on LinkedIn through a connected account — by opening LinkedIn's own people-search inside that account's
 * Live session, where a human browses and connects. The console never runs automated searches or sends connection
 * requests itself (that is what LinkedIn polices hardest and the top account-ban trigger); it only observes what a
 * teammate does in Live (see docs/event-feed.md). So this page just hands the search off to Live.
 */
export function SearchPage() {
  const { accountId } = useParams();
  const nav = useNavigate();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const current = accounts.data?.find((a) => a.id === accountId) ?? accounts.data?.[0];

  const [keywords, setKeywords] = useState('');
  const canSearch = current && current.level !== 'READ';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = keywords.trim();
    if (!q || !current) return;
    // Hand off to the account's Live session; the viewer opens LinkedIn's real people-search for that query, as if the
    // teammate typed the address. From there they browse and click LinkedIn's own Connect button.
    nav(`/accounts/${current.id}/live?search=${encodeURIComponent(q)}`);
  };

  return (
    <PageScroll>
      <PageHeader title="Search">
        {accounts.data && accounts.data.length > 0 && (
          <select className="input w-56" value={current?.id ?? ''} onChange={(e) => nav(`/search/${e.target.value}`)}>
            {accounts.data.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        )}
      </PageHeader>

      {!current && (
        <div className="card">
          <Empty title="No LinkedIn accounts">Connect an account first.</Empty>
        </div>
      )}

      {current && !canSearch && (
        <div className="card">
          <Empty title="Read-only on this account">You need Reply or Full access on this account to open its Live session.</Empty>
        </div>
      )}

      {current && canSearch && (
        <div className="card p-5">
          <form onSubmit={submit} className="flex items-center gap-3">
            <div className="relative flex-1">
              <SearchIcon size={16} className="absolute left-3 top-2.5 text-subtle" />
              <input
                className="input pl-9"
                placeholder="Search people on LinkedIn by name, title or company"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                autoFocus
              />
            </div>
            <button type="submit" className="btn-primary" disabled={!keywords.trim()}>
              <Monitor size={16} /> Search in Live
            </button>
          </form>

          <div className="mt-5 flex items-start gap-3 rounded-lg border border-border bg-surface-muted p-4 text-sm text-muted">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <div>
              <p className="font-medium text-foreground">Searching happens in {current.label}'s own LinkedIn session.</p>
              <p className="mt-1">
                This opens LinkedIn's real people-search in <span className="font-medium">Live</span>, where you browse results and click
                LinkedIn's own <span className="font-medium">Connect</span> button yourself. The console never runs automated searches and
                never sends connection requests — that keeps the account safe. Connection requests and replies you make there are still
                tracked automatically.
              </p>
            </div>
          </div>
        </div>
      )}
    </PageScroll>
  );
}
