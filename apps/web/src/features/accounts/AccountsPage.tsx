import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, LogIn, MonitorPlay, Pause, Play, Plus, RotateCw, Settings2, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { isAdmin, useMe } from '../../App';
import { PageScroll } from '../../components/Layout';
import { Avatar, Empty, Modal, PageHeader, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { TIMEZONES, timeAgo } from '../../lib/format';
import { toast } from '../../lib/toast';
import type { Account, Level } from '../../types';
import { ExportChatsMenu, ImportModal } from './DataTools';
import { isSyncing, SyncProgress } from './SyncProgress';

export function AccountsPage() {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [granting, setGranting] = useState<Account | null>(null);
  const [importing, setImporting] = useState<Account | null>(null);
  const me = useMe();

  return (
    <PageScroll>
      <PageHeader title="LinkedIn accounts">
        {isAdmin(me) && !!accounts.data?.length && <ExportChatsMenu accounts={accounts.data} />}
        <button onClick={() => setAdding(true)} className="btn-primary">
          <Plus size={16} /> Connect LinkedIn account
        </button>
      </PageHeader>
      <p className="mb-5 text-sm text-slate-600">
        Each account runs in its own secure browser on your server. You log in once through a live window (including 2FA). After that your
        team works from the unified inbox.
      </p>
      {accounts.data?.length === 0 && (
        <div className="card">
          <Empty title="No LinkedIn accounts yet">
            Click <b>Connect LinkedIn account</b> to add the first one.
          </Empty>
        </div>
      )}
      <div className="space-y-3">
        {accounts.data?.map((a) => (
          <AccountCard key={a.id} a={a} onEdit={() => setEditing(a)} onGrants={() => setGranting(a)} onImport={() => setImporting(a)} />
        ))}
      </div>
      {adding && <AddAccountModal onClose={() => setAdding(false)} />}
      {editing && <EditAccountModal a={editing} onClose={() => setEditing(null)} />}
      {granting && <GrantsModal a={granting} onClose={() => setGranting(null)} />}
      {importing && <ImportModal a={importing} onClose={() => setImporting(null)} />}
    </PageScroll>
  );
}

function AccountCard({ a, onEdit, onGrants, onImport }: { a: Account; onEdit: () => void; onGrants: () => void; onImport: () => void }) {
  const me = useMe();
  const qc = useQueryClient();
  const full = a.level === 'FULL';
  const needsLogin = a.status === 'AWAITING_LOGIN' || a.status === 'NEEDS_ATTENTION';
  const canLogin = full || a.ownerUserId === me.id;

  const action = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok, 'success');
      qc.invalidateQueries({ queryKey: ['accounts'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = () => {
    if (!confirm(`Disconnect "${a.label}"? Its browser session and all synced messages will be deleted from this server.`)) return;
    action(() => api.del(`/api/accounts/${a.id}`), 'Account disconnected');
  };

  return (
    <div className="card flex flex-wrap items-center gap-4 p-4">
      <Avatar name={a.displayName ?? a.label} src={a.avatarUrl} size={52} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{a.label}</span>
          <StatusBadge status={a.status} />
          {a.sendPaused && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800" title={a.pausedReason ?? undefined}>
              {a.pausedReason ? 'Sending paused automatically' : 'Sending paused'}
            </span>
          )}
        </div>
        <div className="truncate text-sm text-slate-600">
          {a.displayName ? `${a.displayName}${a.headline ? ` · ${a.headline}` : ''}` : 'Not logged in yet'}
        </div>
        <div className="text-xs text-slate-500">
          Connected by {a.ownerName} · {a.timezone}
          {a.hasProxy ? ' · via proxy' : ''} · limit {a.effectiveSendCap ?? a.dailySendCap}/day
          {a.rampDaysLeft ? ` (ramping up to ${a.dailySendCap} in ${a.rampDaysLeft} day${a.rampDaysLeft === 1 ? '' : 's'})` : ''}
          {a.newChatCap !== undefined && `, new chats ${a.newChatCap}/day`}
          {a.lastSeenAt && ` · last check ${timeAgo(a.lastSeenAt)}`} · your access: {a.level}
        </div>
        {a.lastError && <div className="mt-1 text-xs text-red-600">{a.lastError}</div>}
        {a.pausedReason && (
          <div className="mt-1 text-xs text-amber-700">
            {a.pausedReason}. Check the account in Live View, then resume sending (⏵) when it looks normal.
          </div>
        )}
        {isSyncing(a.sync) && <SyncProgress sync={a.sync} />}
      </div>
      <div className="flex flex-wrap gap-2">
        {needsLogin && canLogin && (
          <Link to={`/accounts/${a.id}/connect`} className="btn-primary">
            <LogIn size={16} /> {a.status === 'AWAITING_LOGIN' ? 'Log in' : 'Re-login'}
          </Link>
        )}
        {(full || a.level === 'REPLY') && a.status === 'CONNECTED' && (
          <Link to={`/accounts/${a.id}/live`} className="btn-outline">
            <MonitorPlay size={16} /> Live LinkedIn
          </Link>
        )}
        {full && (
          <>
            <button
              onClick={() =>
                action(
                  () => api.patch(`/api/accounts/${a.id}`, { sendPaused: !a.sendPaused }),
                  a.sendPaused ? 'Sending resumed' : 'Sending paused',
                )
              }
              className="btn-ghost"
              title={a.sendPaused ? 'Resume sending' : 'Pause sending'}
            >
              {a.sendPaused ? <Play size={16} /> : <Pause size={16} />}
            </button>
            <button onClick={onGrants} className="btn-ghost" title="Team access">
              <ShieldCheck size={16} />
            </button>
            <button onClick={onEdit} className="btn-ghost" title="Settings">
              <Settings2 size={16} />
            </button>
            <button onClick={onImport} className="btn-ghost" title="Import LinkedIn data archive (connections, older chats)">
              <Upload size={16} />
            </button>
            {a.status === 'CONNECTED' && !isSyncing(a.sync) && (
              <button
                onClick={() =>
                  confirm('Load the 100 most recent chats with their history again, then all connections? This takes a few minutes.') &&
                  action(() => api.post(`/api/accounts/${a.id}/resync`), 'Full sync started')
                }
                className="btn-ghost"
                title="Sync chats, history and connections again"
              >
                <History size={16} />
              </button>
            )}
            <button
              onClick={() => action(() => api.post(`/api/accounts/${a.id}/restart`), 'Restarting browser…')}
              className="btn-ghost"
              title="Restart browser"
            >
              <RotateCw size={16} />
            </button>
            {(isAdmin(me) || a.ownerUserId === me.id) && (
              <button onClick={remove} className="btn-ghost text-red-600" title="Disconnect">
                <Trash2 size={16} />
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function AddAccountModal({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [label, setLabel] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Chicago');
  const [proxyServer, setProxy] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const zones = TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES];

  const create = async () => {
    setBusy(true);
    try {
      const a = await api.post<Account>('/api/accounts', { label, timezone, language: navigator.language || 'en-US', proxyServer });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      nav(`/accounts/${a.id}/connect`);
    } catch (e) {
      toast((e as Error).message, 'error');
      setBusy(false);
    }
  };

  return (
    <Modal title="Connect a LinkedIn account" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Name for this account</label>
          <input className="input" placeholder="e.g. Sara – Sales" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
        </div>
        <div>
          <label className="label">Timezone of the account owner</label>
          <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {zones.map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">The browser uses this so LinkedIn sees the owner's usual time.</p>
        </div>
        <button onClick={() => setAdvanced((s) => !s)} className="text-xs font-semibold text-brand">
          {advanced ? 'Hide' : 'Show'} advanced
        </button>
        {advanced && (
          <div>
            <label className="label">Proxy (only if the owner is outside your server's country)</label>
            <input
              className="input"
              placeholder="http://user:pass@host:port"
              value={proxyServer}
              onChange={(e) => setProxy(e.target.value)}
            />
          </div>
        )}
        <div className="rounded-md bg-blue-50 p-3 text-xs text-slate-700">
          Next you'll see LinkedIn's login page in a live window. Sign in with email + password and complete 2FA. Passkeys don't work in a
          remote browser.
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button onClick={create} disabled={!label.trim() || busy} className="btn-primary">
            {busy ? 'Starting browser…' : 'Continue'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function EditAccountModal({ a, onClose }: { a: Account; onClose: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState(a.label);
  const [cap, setCap] = useState(a.dailySendCap);
  const [newChatCap, setNewChatCap] = useState(a.newChatCap ?? 20);
  const [skipRamp, setSkipRamp] = useState(false);
  const [timezone, setTimezone] = useState(a.timezone);
  const [proxyServer, setProxy] = useState<string | undefined>(undefined);
  const save = async () => {
    try {
      const body: Record<string, unknown> = { label, dailySendCap: cap, newChatCap };
      if (skipRamp) body.skipRamp = true;
      if (timezone !== a.timezone) body.timezone = timezone;
      if (proxyServer !== undefined) body.proxyServer = proxyServer;
      await api.patch(`/api/accounts/${a.id}`, body);
      qc.invalidateQueries({ queryKey: ['accounts'] });
      toast('Saved', 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal title={`Settings · ${a.label}`} onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label className="label">Name</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div>
          <label className="label">Max messages per 24h (whole team)</label>
          <input className="input" type="number" min={1} max={500} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
        </div>
        <div>
          <label className="label">Of which new chats (people you haven't messaged before)</label>
          <input
            className="input"
            type="number"
            min={0}
            max={200}
            value={newChatCap}
            onChange={(e) => setNewChatCap(Number(e.target.value))}
          />
          <p className="mt-1 text-xs text-slate-500">Cold outreach is what LinkedIn watches most; replies in existing chats are safer.</p>
        </div>
        {!!a.rampDaysLeft && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={skipRamp} onChange={(e) => setSkipRamp(e.target.checked)} />
            <span>Use the full limit now (skip the ramp-up). Only for an established LinkedIn account that already sends this much.</span>
          </label>
        )}
        <div>
          <label className="label">Timezone</label>
          <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Proxy {a.hasProxy ? '(currently set, leave empty to keep, type "none" to remove)' : '(none)'}</label>
          <input
            className="input"
            placeholder="http://user:pass@host:port"
            onChange={(e) => setProxy(e.target.value === 'none' ? '' : e.target.value || undefined)}
          />
        </div>
        <p className="text-xs text-slate-500">Changing timezone or proxy restarts the account's browser. The LinkedIn login is kept.</p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button onClick={save} className="btn-primary">
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

type GrantRow = { userId: string; name: string; role: string; level: Level | null };

function GrantsModal({ a, onClose }: { a: Account; onClose: () => void }) {
  const grants = useQuery({ queryKey: ['grants', a.id], queryFn: () => api.get<GrantRow[]>(`/api/accounts/${a.id}/grants`) });
  const [changes, setChanges] = useState<Record<string, Level | null>>({});
  const save = async () => {
    try {
      await api.put(
        `/api/accounts/${a.id}/grants`,
        Object.entries(changes).map(([userId, level]) => ({ userId, level })),
      );
      toast('Access updated', 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal title={`Team access · ${a.label}`} onClose={onClose} wide>
      <p className="mb-3 text-xs text-slate-600">
        <b>Read</b>: see conversations · <b>Reply</b>: send messages + watch Live LinkedIn · <b>Full</b>: control Live LinkedIn, settings,
        re-login. Owners and admins always have full access.
      </p>
      <div className="divide-y divide-slate-100">
        {grants.data?.map((g) => (
          <div key={g.userId} className="flex items-center gap-3 py-2">
            <Avatar name={g.name} size={30} />
            <span className="flex-1 text-sm">
              {g.name} <span className="text-xs text-slate-500">{g.role !== 'MEMBER' ? `(${g.role.toLowerCase()})` : ''}</span>
            </span>
            {g.role !== 'MEMBER' ? (
              <span className="text-xs text-slate-500">Full</span>
            ) : (
              <select
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                value={(changes[g.userId] !== undefined ? changes[g.userId] : g.level) ?? ''}
                onChange={(e) => setChanges((c) => ({ ...c, [g.userId]: (e.target.value || null) as Level | null }))}
              >
                <option value="">No access</option>
                <option value="READ">Read</option>
                <option value="REPLY">Reply</option>
                <option value="FULL">Full</option>
              </select>
            )}
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost">
          Cancel
        </button>
        <button onClick={save} disabled={!Object.keys(changes).length} className="btn-primary">
          Save
        </button>
      </div>
    </Modal>
  );
}
