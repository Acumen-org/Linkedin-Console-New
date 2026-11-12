import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, ExternalLink, Monitor, Search as SearchIcon, SlidersHorizontal, UserPlus } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { PageScroll } from '../../components/Layout';
import { Avatar, Empty, PageHeader } from '../../components/ui';
import { api, qs } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Account } from '../../types';

/** The id to open a result in Live LinkedIn (C7): the vanity id when known, else the (obfuscated) member id. */
const liveProfileId = (r: { profileUrl: string | null; memberUrn: string | null }): string | null =>
  r.profileUrl?.match(/\/in\/([^/?#]+)/)?.[1] ?? r.memberUrn?.match(/urn:li:fsd_profile:(.+)/)?.[1] ?? null;

interface SearchResult {
  memberUrn: string | null;
  name: string;
  headline: string | null;
  location: string | null;
  degree: number | null;
  profileUrl: string | null;
  avatarUrl: string | null;
}
interface SearchResponse {
  results: SearchResult[];
  total: number | null;
  /** LinkedIn's commercial-use / search limit was reached. */
  limited: boolean;
  page: number;
}

/** Search all of LinkedIn for people (non-connections included) through a connected account's session. */
export function SearchPage() {
  const { accountId } = useParams();
  const nav = useNavigate();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const current = accounts.data?.find((a) => a.id === accountId) ?? accounts.data?.[0];

  const [keywords, setKeywords] = useState('');
  const [title, setTitle] = useState('');
  const [company, setCompany] = useState('');
  const [location, setLocation] = useState('');
  const [degree, setDegree] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  // The actual query that's been run (so results don't refetch on every keystroke — each search hits LinkedIn).
  const [run, setRun] = useState<{ q: string; title: string; company: string; location: string; degree: string } | null>(null);
  const [page, setPage] = useState(1);
  // Connection-request state per person (memberUrn → sending/done), so the button reflects what's happened.
  const [invited, setInvited] = useState<Record<string, 'sending' | 'done'>>({});

  const connect = async (memberUrn: string) => {
    if (!current || invited[memberUrn]) return;
    const note = window.prompt('Add a note to the connection request? (optional — leave blank to send without one)') ?? undefined;
    setInvited((m) => ({ ...m, [memberUrn]: 'sending' }));
    try {
      const r = await api.post<{ ok: boolean; already: boolean }>(`/api/accounts/${current.id}/invite`, {
        memberUrn,
        note: note?.trim() || undefined,
      });
      setInvited((m) => ({ ...m, [memberUrn]: 'done' }));
      toast(r.already ? 'Already connected or request pending' : 'Connection request sent', 'success');
    } catch (e) {
      setInvited((m) => {
        const { [memberUrn]: _, ...rest } = m;
        return rest;
      });
      toast((e as Error).message, 'error');
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = keywords.trim();
    if (!q || !current) return;
    setPage(1);
    setRun({ q, title: title.trim(), company: company.trim(), location: location.trim(), degree });
  };

  const search = useQuery({
    queryKey: ['people-search', current?.id, run, page],
    queryFn: () =>
      api.get<SearchResponse>(
        `/api/accounts/${current!.id}/search${qs({
          q: run!.q,
          page,
          title: run!.title || undefined,
          company: run!.company || undefined,
          location: run!.location || undefined,
          degree: run!.degree || undefined,
        })}`,
      ),
    enabled: !!current && !!run,
    placeholderData: keepPreviousData,
    retry: false,
  });
  const data = search.data;
  const canSearch = current && current.level !== 'READ';

  return (
    <PageScroll>
      <PageHeader title="Search">
        <select className="input w-56" value={current?.id ?? ''} onChange={(e) => nav(`/search/${e.target.value}`)}>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </PageHeader>

      {!current && (
        <div className="card">
          <Empty title="No LinkedIn accounts">Connect an account first.</Empty>
        </div>
      )}

      {current && !canSearch && (
        <div className="card">
          <Empty title="Read-only on this account">You need Reply or Full access on this account to search LinkedIn with it.</Empty>
        </div>
      )}

      {current && canSearch && (
        <div className="card">
          <form onSubmit={submit} className="border-b border-border p-3">
            <div className="flex items-center gap-3">
              <div className="relative flex-1">
                <SearchIcon size={16} className="absolute left-3 top-2.5 text-subtle" />
                <input
                  className="input pl-9"
                  placeholder="Search people on LinkedIn by name, title or company"
                  value={keywords}
                  onChange={(e) => setKeywords(e.target.value)}
                />
              </div>
              <button type="button" className="btn-ghost" onClick={() => setShowFilters((s) => !s)} title="Filters">
                <SlidersHorizontal size={16} /> Filters
              </button>
              <button type="submit" className="btn-primary" disabled={!keywords.trim() || search.isFetching}>
                {search.isFetching ? 'Searching…' : 'Search'}
              </button>
            </div>
            {showFilters && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
                <input className="input" placeholder="Job title" value={title} onChange={(e) => setTitle(e.target.value)} />
                <input className="input" placeholder="Current company" value={company} onChange={(e) => setCompany(e.target.value)} />
                <input className="input" placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} />
                <select className="input" value={degree} onChange={(e) => setDegree(e.target.value)}>
                  <option value="">Any connection</option>
                  <option value="2">2nd degree</option>
                  <option value="3">3rd+ degree</option>
                </select>
              </div>
            )}
          </form>

          {!run && (
            <Empty icon={<SearchIcon size={32} />} title="Search LinkedIn">
              Find people you're not connected to, through {current.label}'s session. Searches are paced and capped to keep the account
              safe.
            </Empty>
          )}

          {search.isError && <div className="p-4 text-sm text-red-700 dark:text-red-300">{(search.error as Error).message}</div>}

          {data?.limited && (
            <div className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              LinkedIn's monthly search limit for this account has been reached. It resets at the start of next month.
            </div>
          )}

          {run && !search.isError && data?.results.length === 0 && !data.limited && (
            <Empty icon={<SearchIcon size={32} />} title="No results">
              No people matched that search.
            </Empty>
          )}

          <div className={`divide-y divide-border ${search.isPlaceholderData ? 'opacity-60' : ''}`}>
            {data?.results.map((r, i) => (
              <div key={r.memberUrn ?? r.profileUrl ?? `${r.name}-${i}`} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={r.name} src={r.avatarUrl} size={44} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {r.profileUrl ? (
                      <a href={r.profileUrl} target="_blank" rel="noreferrer" className="font-semibold hover:underline">
                        {r.name}
                      </a>
                    ) : (
                      <span className="font-semibold">{r.name}</span>
                    )}
                    {r.degree && <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[11px] text-subtle">{r.degree}°</span>}
                  </div>
                  {r.headline && <div className="truncate text-sm text-muted">{r.headline}</div>}
                  {r.location && <div className="truncate text-xs text-subtle">{r.location}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {/* Open the profile in this account's own LinkedIn session (C7). */}
                  {current && liveProfileId(r) && (
                    <Link
                      to={`/accounts/${current.id}/live?profile=${encodeURIComponent(liveProfileId(r) as string)}`}
                      className="btn-ghost"
                      title="Open in Live LinkedIn"
                    >
                      <Monitor size={14} /> Live
                    </Link>
                  )}
                  {r.profileUrl && (
                    <a href={r.profileUrl} target="_blank" rel="noreferrer" className="btn-outline" title="Open profile">
                      <ExternalLink size={14} /> View
                    </a>
                  )}
                  {/* Connect needs a member URN (the id LinkedIn invites by); 1st-degree are already connected. */}
                  {r.memberUrn && r.degree !== 1 && (
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={!!invited[r.memberUrn]}
                      onClick={() => connect(r.memberUrn as string)}
                    >
                      {invited[r.memberUrn] === 'done' ? (
                        <>
                          <Check size={14} /> Sent
                        </>
                      ) : invited[r.memberUrn] === 'sending' ? (
                        'Sending…'
                      ) : (
                        <>
                          <UserPlus size={14} /> Connect
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {run && !!data?.results.length && (
            <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-sm text-muted">
              <span>Page {data.page}</span>
              <div className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  className="btn-ghost px-2"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  title="Previous page"
                >
                  <ChevronLeft size={16} />
                </button>
                {/* LinkedIn doesn't give a reliable total, so "next" is available while a full page comes back. */}
                <button
                  type="button"
                  className="btn-ghost px-2"
                  disabled={data.results.length < 10 || search.isFetching}
                  onClick={() => setPage((p) => p + 1)}
                  title="Next page"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </PageScroll>
  );
}
