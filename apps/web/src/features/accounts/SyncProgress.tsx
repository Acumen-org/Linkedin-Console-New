import type { AccountSync } from '@linkedin-console/contracts';
import { Loader2 } from 'lucide-react';

const Bar = ({ value, max }: { value: number; max: number }) => (
  <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
    <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
  </div>
);

const eta = (min: number | null) => (min === null ? '' : min < 1 ? ' · less than a minute left' : ` · about ${min} min left`);

/** True while a newly connected account is still being filled in. */
export const isSyncing = (s: AccountSync | null | undefined): s is AccountSync => !!s && !s.finishedAt;

/** First-sync progress of a newly connected account (chats first, then the full connection list). */
export function SyncProgress({ sync, compact = false }: { sync: AccountSync; compact?: boolean }) {
  const { conversations: c, history: h, connections: n } = sync;
  const chatsDone = c.done && h.done >= h.total;
  if (compact) {
    return (
      <div className="flex items-center gap-1 text-[11px] text-slate-500" title="Importing this account's recent chats and connections">
        <Loader2 size={11} className="animate-spin" />
        {chatsDone ? `connections ${n.loaded}${n.total ? `/${n.total}` : ''}` : `chats ${h.done}/${Math.max(h.total, c.loaded)}`}
      </div>
    );
  }
  return (
    <div className="mt-2 grid gap-2 rounded-md bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-3">
      <div>
        <div className="mb-1 flex justify-between">
          <span>Recent chats</span>
          <span>{c.done ? `${c.loaded} loaded` : `${c.loaded}/${c.target}`}</span>
        </div>
        <Bar value={c.done ? 1 : c.loaded} max={c.done ? 1 : c.target} />
      </div>
      <div>
        <div className="mb-1 flex justify-between">
          <span>Chat history</span>
          <span>
            {h.done}/{Math.max(h.total, c.loaded)}
          </span>
        </div>
        <Bar value={h.done} max={Math.max(h.total, c.loaded, 1)} />
      </div>
      <div>
        <div className="mb-1 flex justify-between">
          <span>Connections</span>
          <span>
            {n.done ? `${n.loaded} · done` : `${n.loaded}${n.total ? ` of ${n.total.toLocaleString()}` : ''}`}
            {!n.done && eta(n.etaMinutes)}
          </span>
        </div>
        <Bar value={n.done ? 1 : n.loaded} max={n.done ? 1 : (n.total ?? Math.max(n.loaded * 2, 100))} />
      </div>
    </div>
  );
}
