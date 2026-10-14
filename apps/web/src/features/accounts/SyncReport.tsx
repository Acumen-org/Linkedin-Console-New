import type { AccountSync, InboxCheck } from '@linkedin-console/contracts';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Download, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Modal } from '../../components/ui';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import type { Account } from '../../types';
import { isSyncing, SyncProgress } from './SyncProgress';

type Wait = 'no_thread' | 'unread' | 'queued' | 'retrying' | 'not_requested';

interface Report {
  inboxCheck: (InboxCheck & { at: string; full: boolean }) | null;
  allChats: { loaded: number; startedAt: string } | null;
  status: string;
  sync: AccountSync | null;
  historyRequestLearned: boolean;
  sendRequestLearned: boolean;
  conversations: number;
  connections: number;
  recent: { count: number; withHistory: number; waiting: number };
  chats: {
    id: string;
    name: string;
    lastMessageAt: string | null;
    unread: number;
    messages: number;
    historyAt: string | null;
    waiting: Wait | null;
  }[];
}

const WAIT_LABEL: Record<Wait, string> = {
  no_thread: 'LinkedIn gave no thread for this chat',
  unread: 'Unread: waits until a read chat teaches the quiet history request (opening it would mark it read)',
  queued: 'In the queue',
  retrying: 'No answer yet; retried every 10 minutes',
  not_requested: 'Not requested yet',
};

const Tile = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="rounded-md bg-slate-50 p-3">
    <div className="text-xs text-slate-500">{label}</div>
    <div className="text-lg font-semibold">{value}</div>
    {sub && <div className="text-[11px] text-slate-500">{sub}</div>}
  </div>
);

/** What the first sync loaded for an account, to check it: recent chats, their history, and what still waits. */
export function SyncReportModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const [onlyWaiting, setOnlyWaiting] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const report = useQuery({
    queryKey: ['sync-report', account.id],
    queryFn: () => api.get<Report>(`/api/accounts/${account.id}/sync-report`),
    refetchInterval: 5000,
  });
  const r = report.data;
  const chats = r?.chats.filter((c) => !onlyWaiting || c.waiting) ?? [];

  const retry = async () => {
    setRetrying(true);
    try {
      const { requested } = await api.post<{ requested: number }>(`/api/accounts/${account.id}/sync-report/retry`);
      toast(requested ? `Asked LinkedIn again for ${requested} chat${requested === 1 ? '' : 's'}` : 'Nothing is missing', 'success');
      report.refetch();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Modal title={`Sync report: ${account.label}`} onClose={onClose} wide>
      {!r ? (
        <div className="p-6 text-center text-sm text-slate-500">Loading…</div>
      ) : (
        <div className="space-y-4">
          {isSyncing(r.sync) && <SyncProgress sync={r.sync} />}
          {r.sync?.finishedAt && (
            <div className="flex items-center gap-1.5 text-sm text-emerald-700">
              <CheckCircle2 size={16} /> First sync finished {timeAgo(r.sync.finishedAt)}
            </div>
          )}
          {!r.sync && <div className="text-sm text-slate-500">This account connected before sync reports existed.</div>}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Tile label="Recent chats" value={`${r.recent.count} / 100`} sub={`${r.conversations} chats in total`} />
            <Tile
              label="With history"
              value={`${r.recent.withHistory} / ${r.recent.count}`}
              sub={r.recent.waiting ? `${r.recent.waiting} still waiting` : 'all in'}
            />
            <Tile label="Connections" value={r.connections.toLocaleString()} />
            <Tile
              label="Quiet history request"
              value={r.historyRequestLearned ? 'Learned' : 'Not yet'}
              sub={r.historyRequestLearned ? 'chats load without opening them' : 'learned when a read chat is opened'}
            />
          </div>

          <InboxCheckPanel account={account} report={r} onStarted={() => report.refetch()} />

          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={onlyWaiting} onChange={(e) => setOnlyWaiting(e.target.checked)} />
              Only chats still waiting for their history
            </label>
            {account.level === 'FULL' && r.recent.waiting > 0 && (
              <button onClick={retry} disabled={retrying || r.status !== 'CONNECTED'} className="btn-outline">
                <RefreshCw size={14} className={retrying ? 'animate-spin' : ''} /> Retry the missing ones
              </button>
            )}
          </div>

          <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
            {chats.length === 0 && (
              <div className="p-4 text-center text-sm text-slate-500">
                {onlyWaiting ? 'Every recent chat has its history.' : 'No chats yet.'}
              </div>
            )}
            {chats.map((c) => (
              <div key={c.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                {c.waiting ? (
                  <Clock size={16} className="shrink-0 text-amber-500" />
                ) : (
                  <CheckCircle2 size={16} className="shrink-0 text-emerald-600" />
                )}
                <div className="min-w-0 flex-1">
                  <Link to={`/inbox/${c.id}`} className="truncate font-medium hover:underline">
                    {c.name}
                  </Link>
                  <div className="truncate text-xs text-slate-500">
                    {c.waiting
                      ? WAIT_LABEL[c.waiting]
                      : `${c.messages} message${c.messages === 1 ? '' : 's'} · history loaded ${timeAgo(c.historyAt!)}`}
                  </div>
                </div>
                <div className="shrink-0 text-right text-xs text-slate-500">
                  {c.lastMessageAt && timeAgo(c.lastMessageAt)}
                  {c.unread > 0 && <div className="text-brand">{c.unread} unread</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * The last conversation list load: how many chats LinkedIn's page listed and how many its data described. A big
 * gap means reading LinkedIn's data broke (its format changed); the missing chats were added from the page.
 * Also "Load all chats" (the whole list, not only the recent 100).
 */
function InboxCheckPanel({ account, report: r, onStarted }: { account: Account; report: Report; onStarted: () => void }) {
  const c = r.inboxCheck;
  const degraded = !!c && c.listed >= 5 && c.recognised < c.listed / 2;
  const start = async () => {
    try {
      await api.post(`/api/accounts/${account.id}/load-all-chats`);
      toast('Loading all chats. This takes a few minutes; history follows for the last 90 days.', 'success');
      onStarted();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className={`rounded-md border p-3 text-sm ${degraded ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-center gap-2">
        {degraded && <AlertTriangle size={16} className="text-amber-600" />}
        <span className="flex-1">
          {c ? (
            <>
              Last chat list load {timeAgo(c.at)}
              {c.full ? ' (all chats)' : ''}: LinkedIn listed <b>{c.listed}</b> chats, its data described <b>{c.recognised}</b>
              {c.fromPage ? (
                <>
                  , <b>{c.fromPage}</b> added from the page
                </>
              ) : null}
              .
            </>
          ) : (
            'No chat list load reported yet (it runs when the account connects, and with Load all chats).'
          )}
        </span>
        {account.level === 'FULL' &&
          (r.allChats ? (
            <span className="text-xs text-slate-500">Loading all chats… {r.allChats.loaded} listed so far</span>
          ) : (
            <button type="button" onClick={start} disabled={r.status !== 'CONNECTED'} className="btn-outline text-xs">
              <Download size={13} /> Load all chats
            </button>
          ))}
      </div>
      {degraded && (
        <p className="mt-1 text-xs text-amber-800">
          LinkedIn changed how it sends the chat list, so most chats were added from the page: names only, their messages may be missing
          until the bridge is updated. The admins were alerted. A LinkedIn data archive (Import) brings the full history now.
        </p>
      )}
    </div>
  );
}
