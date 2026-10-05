import { useInfiniteQuery } from '@tanstack/react-query';
import { api, qs } from '../api';
import { PageScroll } from '../components/Layout';
import { PageHeader } from '../components/ui';
import { fullTime } from '../util';

type Entry = { id: number; action: string; meta: Record<string, unknown>; ip: string | null; createdAt: string; accountLabel: string | null; userName: string | null };

const LABELS: Record<string, string> = {
  'auth.login': 'Logged in', 'message.send': 'Sent a message', 'message.start_chat': 'Started a chat', 'live.opened': 'Opened Live LinkedIn',
  'account.created': 'Connected an account', 'account.deleted': 'Disconnected an account', 'account.status': 'Account status changed',
  'account.grants_changed': 'Changed account access', 'account.updated': 'Changed account settings', 'account.restarted': 'Restarted browser',
  'user.created': 'Added a teammate', 'user.updated': 'Updated a teammate', 'conversation.assigned': 'Assigned a conversation',
};

export function AuditPage() {
  const log = useInfiniteQuery({
    queryKey: ['audit'],
    queryFn: ({ pageParam }) => api.get<Entry[]>(`/api/audit${qs({ before: pageParam })}`),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 100 ? last[last.length - 1].id : undefined),
  });
  return (
    <PageScroll>
      <PageHeader title="Audit log" />
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
            <tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Who</th><th className="px-4 py-2">What</th><th className="px-4 py-2">Account</th><th className="px-4 py-2">Details</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {log.data?.pages.flat().map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap px-4 py-2 text-slate-500">{fullTime(e.createdAt)}</td>
                <td className="px-4 py-2">{e.userName ?? 'System'}</td>
                <td className="px-4 py-2">{LABELS[e.action] ?? e.action}</td>
                <td className="px-4 py-2">{e.accountLabel ?? ''}</td>
                <td className="max-w-xs truncate px-4 py-2 font-mono text-xs text-slate-500" title={JSON.stringify(e.meta)}>{Object.keys(e.meta ?? {}).length ? JSON.stringify(e.meta) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {log.hasNextPage && <button onClick={() => log.fetchNextPage()} className="w-full py-3 text-sm font-semibold text-brand hover:bg-slate-50">Load more</button>}
      </div>
    </PageScroll>
  );
}
