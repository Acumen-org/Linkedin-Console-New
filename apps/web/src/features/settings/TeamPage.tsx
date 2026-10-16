import type { DirectoryInfo } from '@linkedin-console/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '../../App';
import { PageScroll } from '../../components/Layout';
import { Avatar, Modal, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { fullTime } from '../../lib/format';
import { useAppConfig } from '../../lib/queries';
import { toast } from '../../lib/toast';
import type { User } from '../../types';
import { BulkAssignModal, StaffAccessModal } from './StaffAccess';

const Badge = ({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'blue' | 'red' }) => (
  <span
    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
      tone === 'blue' ? 'bg-blue-50 text-brand' : tone === 'red' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'
    }`}
  >
    {children}
  </span>
);

/** How teammates sign in, and the staff list they follow (Twilio console or Twenty workspace). */
function DirectoryCard({ info }: { info: DirectoryInfo }) {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);
  const { staffSync: sync } = info;
  const last = sync.last;
  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api.post<NonNullable<DirectoryInfo['staffSync']['last']>>('/api/users/directory/sync');
      toast(r.ok ? 'Staff list synced' : `Sync failed: ${r.error}`, r.ok ? 'success' : 'error');
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['directory'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className="card mb-4 grid gap-4 p-4 text-sm md:grid-cols-2">
      <div>
        <div className="mb-1 flex items-center gap-1.5 font-semibold">
          <ShieldCheck size={16} className="text-brand" /> Sign-in
        </div>
        {info.microsoft ? (
          <p className="text-slate-600">
            Company Microsoft 365 accounts (MFA and access policies from Microsoft).{' '}
            {info.passwordSignin === 'owner' ? 'Passwords: owner only, for emergencies.' : 'Passwords are also allowed.'}
          </p>
        ) : (
          <p className="text-slate-600">Email and password. Configure Microsoft 365 sign-in to use company accounts and MFA.</p>
        )}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="font-semibold">{sync.kind === 'twenty' ? 'Twenty CRM workspace' : 'Twilio console staff list'}</span>
          {sync.mode !== 'off' && (
            <button type="button" onClick={runNow} disabled={running} className="btn-ghost text-xs">
              <RefreshCw size={13} className={running ? 'animate-spin' : ''} /> Sync now
            </button>
          )}
        </div>
        {sync.mode === 'off' ? (
          <p className="text-slate-600">Not connected.</p>
        ) : (
          <>
            <p className="text-slate-600">
              {sync.mode === 'provision'
                ? 'Adds staff (no account access until an admin assigns it) and disables leavers.'
                : 'Disables leavers.'}
            </p>
            {last && (
              <p className={`mt-1 text-xs ${last.ok ? 'text-slate-500' : 'text-red-600'}`}>
                Last run {fullTime(last.at)}:{' '}
                {last.ok
                  ? `${last.staff} staff · ${last.linked} linked · ${last.provisioned} added · ${last.disabled} disabled · ${last.reenabled} re-enabled`
                  : last.error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface CrmStatus {
  enabled: boolean;
  since?: string;
  pending?: number;
  failed?: number;
  synced24h?: number;
  people?: number;
  needsBinding?: number;
  reviewPending?: number;
  reviewed?: number;
  last?: { at: string; ok: boolean; error?: string } | null;
}

/** Send limits for staff: the team default per 24 hours, and when admins are alerted about a burst. */
function StaffLimitsCard() {
  const qc = useQueryClient();
  const limits = useQuery({
    queryKey: ['staff-limits'],
    queryFn: () => api.get<{ dailyCap: number; burstPerHour: number }>('/api/settings/staff-limits'),
  });
  const [form, setForm] = useState<{ dailyCap: number; burstPerHour: number } | null>(null);
  const v = form ?? limits.data;
  if (!v) return null;
  const save = async () => {
    try {
      await api.put('/api/settings/staff-limits', v);
      toast('Send limits saved', 'success');
      setForm(null);
      qc.invalidateQueries({ queryKey: ['staff-limits'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="card mb-4 flex flex-wrap items-end gap-4 p-4 text-sm">
      <div className="min-w-56 flex-1">
        <div className="font-semibold">Staff send limits</div>
        <p className="text-slate-600">
          Each staff member's messages and new chats per 24 hours, over all accounts, on top of each account's own limit. Admins are
          notified when someone gets close to it or sends a burst.
        </p>
      </div>
      <label>
        <span className="label">Per person per 24 hours (0 = no limit)</span>
        <input
          className="input w-40"
          type="number"
          min={0}
          max={1000}
          value={v.dailyCap}
          onChange={(e) => setForm({ ...v, dailyCap: Number(e.target.value) })}
        />
      </label>
      <label>
        <span className="label">Alert above, in one hour (0 = never)</span>
        <input
          className="input w-40"
          type="number"
          min={0}
          max={500}
          value={v.burstPerHour}
          onChange={(e) => setForm({ ...v, burstPerHour: Number(e.target.value) })}
        />
      </label>
      <button type="button" onClick={save} disabled={!form} className="btn-primary">
        Save
      </button>
    </div>
  );
}

/** Twenty CRM sync of prospects and their messages (only shown when CRM_SYNC is on). */
function CrmCard() {
  const status = useQuery({
    queryKey: ['crm-status'],
    queryFn: () => api.get<CrmStatus>('/api/crm/status'),
    refetchInterval: 15_000,
  });
  const s = status.data;
  if (!s?.enabled) return null;
  const retry = async () => {
    try {
      const r = await api.post<{ retried: number }>('/api/crm/retry');
      toast(`Trying ${r.retried} message${r.retried === 1 ? '' : 's'} again`, 'success');
      status.refetch();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="card mb-4 p-4 text-sm">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-semibold">Twenty CRM: prospects and messages</span>
        {!!s.failed && (
          <button type="button" onClick={retry} className="btn-ghost text-xs">
            <RefreshCw size={13} /> Retry {s.failed} failed
          </button>
        )}
      </div>
      <p className="text-slate-600">
        A prospect reaches Twenty only after they reply and are bound to one Person (automatically when exactly one Person has their
        LinkedIn link); then every message since {s.since ? fullTime(s.since) : 'switch-on'} is a note on them. {s.people} prospects bound ·{' '}
        {s.needsBinding ?? 0} replied and waiting to be bound · {s.synced24h} messages logged in the last 24 hours · {s.pending} on their
        way
        {s.failed ? ` · ${s.failed} failed` : ''}.
      </p>
      {(!!s.reviewPending || !!s.reviewed) && (
        <p className="mt-1 text-xs text-slate-500">
          Persons the earlier sync created for prospects who never replied: {s.reviewed ?? 0} marked “LinkedIn Console: review” in Twenty
          {s.reviewPending ? `, ${s.reviewPending} waiting for that field (scripts/twenty-fields.sh)` : ''}. Nothing is deleted.
        </p>
      )}
      {s.last && !s.last.ok && (
        <p className="mt-1 text-xs text-red-600">
          Last problem {fullTime(s.last.at)}: {s.last.error}
        </p>
      )}
    </div>
  );
}

export function TeamPage() {
  const me = useMe();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') });
  const directory = useQuery({ queryKey: ['directory'], queryFn: () => api.get<DirectoryInfo>('/api/users/directory') });
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const [assigning, setAssigning] = useState<User | null>(null);
  const [linking, setLinking] = useState<User | null>(null);
  const crmOn = !!useAppConfig().data?.twentyUrl;
  // Staff picked for assigning accounts to several at once.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
  const isStaff = (u: User) => u.role === 'MEMBER' && !u.disabledAt;
  const togglePick = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const passwordsUsed = !directory.data?.microsoft || directory.data.passwordSignin === 'on';

  const makeOwner = async (u: User) => {
    if (!confirm(`Make ${u.name} the owner? You stay on as an admin, and only they can hand ownership back.`)) return;
    try {
      await api.post(`/api/users/${u.id}/owner`);
      toast(`${u.name} is now the owner`, 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const update = async (u: User, body: Record<string, unknown>, ok: string) => {
    try {
      await api.patch(`/api/users/${u.id}`, body);
      toast(ok, 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <PageScroll>
      <PageHeader title="Team">
        <button type="button" onClick={() => setAdding(true)} className="btn-primary">
          <UserPlus size={16} /> Add staff
        </button>
      </PageHeader>
      <p className="mb-4 text-sm text-slate-600">
        Teammates sign in to this app, never to LinkedIn. Staff see no LinkedIn accounts until an admin assigns them (Assign on each person,
        or tick several), and every message they send is recorded. Admins and the owner see everything.
      </p>
      {directory.data && <DirectoryCard info={directory.data} />}
      <CrmCard />
      <StaffLimitsCard />
      {picked.size > 0 && (
        <div className="card mb-3 flex items-center gap-3 px-4 py-2 text-sm">
          <span className="flex-1">
            {picked.size} staff member{picked.size === 1 ? '' : 's'} selected
          </span>
          <button type="button" onClick={() => setPicked(new Set())} className="btn-ghost text-xs">
            Clear
          </button>
          <button type="button" onClick={() => setBulk(true)} className="btn-primary">
            Assign accounts
          </button>
        </div>
      )}
      <div className="card divide-y divide-slate-100">
        {users.data?.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <input
              type="checkbox"
              className={isStaff(u) ? '' : 'invisible'}
              checked={picked.has(u.id)}
              onChange={() => togglePick(u.id)}
              title="Select to assign accounts to several staff at once"
            />
            <div className={u.disabledAt ? 'opacity-50' : ''}>
              <Avatar name={u.name} size={38} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`font-semibold ${u.disabledAt ? 'text-slate-400' : ''}`}>{u.name}</span>
                {u.id === me.id && <span className="text-xs text-slate-500">(you)</span>}
                {u.microsoftLinked && <Badge tone="blue">Microsoft</Badge>}
                {u.hasPassword === false && !u.microsoftLinked && <Badge>Microsoft sign-in</Badge>}
                {u.source === 'staff_sync' && <Badge>From the staff list</Badge>}
                {u.disabledAt && <Badge tone="red">{u.disabledReason ?? 'Disabled'}</Badge>}
              </div>
              <div className="text-sm text-slate-600">
                {u.email}
                <span className="text-xs text-slate-400">
                  {' '}
                  · {u.lastSignInAt ? `last sign-in ${fullTime(u.lastSignInAt)}` : 'never signed in'}
                </span>
              </div>
            </div>
            {u.role === 'OWNER' ? (
              <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-brand">Owner</span>
            ) : (
              <select
                className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                value={u.role}
                disabled={u.id === me.id}
                onChange={(e) => update(u, { role: e.target.value }, 'Role updated')}
              >
                <option value="MEMBER">Staff</option>
                <option value="AUDITOR">Auditor</option>
                <option value="ADMIN">Admin</option>
              </select>
            )}
            {isStaff(u) && (
              <button type="button" onClick={() => setAssigning(u)} className="btn-outline text-xs">
                {u.accountCount ? `${u.accountCount} account${u.accountCount === 1 ? '' : 's'}` : 'No accounts'} · Assign
              </button>
            )}
            {isStaff(u) && (
              <span className="text-xs text-slate-500" title="Messages and new chats in the last 24 hours, and this person's limit">
                {u.sent24h ?? 0} sent today
                {u.dailySendCap === null || u.dailySendCap === undefined ? '' : u.dailySendCap ? ` / ${u.dailySendCap}` : ' · no limit'}
              </span>
            )}
            {crmOn && u.role !== 'AUDITOR' && !u.disabledAt && (
              <button
                type="button"
                onClick={() => setLinking(u)}
                className="btn-ghost text-xs"
                title="Owner of the Persons they add to Twenty, and their pod"
              >
                {u.twentyMemberId ? 'Twenty ✓' : 'Twenty: not linked'}
                {u.pod ? ` · ${u.pod}` : ''}
              </button>
            )}
            {me.role === 'OWNER' && u.role !== 'OWNER' && !u.disabledAt && (
              <button type="button" onClick={() => makeOwner(u)} className="btn-ghost text-xs">
                Make owner
              </button>
            )}
            {u.role !== 'OWNER' && u.id !== me.id && (
              <>
                {passwordsUsed && (
                  <button type="button" onClick={() => setResetting(u)} className="btn-ghost text-xs">
                    {u.hasPassword === false ? 'Set password' : 'Reset password'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => update(u, { disabled: !u.disabledAt }, u.disabledAt ? 'Enabled' : 'Disabled and signed out')}
                  className="btn-ghost text-xs"
                >
                  {u.disabledAt ? 'Enable' : 'Disable'}
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {adding && <AddUserModal microsoft={!!directory.data?.microsoft} passwords={passwordsUsed} onClose={() => setAdding(false)} />}
      {resetting && <ResetModal user={resetting} onClose={() => setResetting(null)} />}
      {assigning && <StaffAccessModal user={assigning} onClose={() => setAssigning(null)} />}
      {linking && (
        <TwentyLinkModal
          user={linking}
          pods={[...new Set((users.data ?? []).map((u) => u.pod).filter((p): p is string => !!p))]}
          onClose={() => setLinking(null)}
        />
      )}
      {bulk && (
        <BulkAssignModal
          users={users.data?.filter((u) => picked.has(u.id)) ?? []}
          onClose={() => setBulk(false)}
          onDone={() => {
            setBulk(false);
            setPicked(new Set());
          }}
        />
      )}
    </PageScroll>
  );
}

const randomPassword = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 55]).join('');

function AddUserModal({ microsoft, passwords, onClose }: { microsoft: boolean; passwords: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: randomPassword(), role: 'MEMBER' });
  // With Microsoft sign-in, new teammates use their company account by default (no password to share).
  const [withPassword, setWithPassword] = useState(!microsoft);
  const [done, setDone] = useState(false);
  const save = async () => {
    try {
      await api.post('/api/users', { ...form, password: withPassword ? form.password : undefined });
      qc.invalidateQueries({ queryKey: ['users'] });
      setDone(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  if (done) {
    return (
      <Modal title="Teammate added" onClose={onClose}>
        {withPassword ? (
          <>
            <p className="text-sm">
              Share these sign-in details with {form.name} privately. They can change the password under their profile.
            </p>
            <pre className="mt-3 rounded-md bg-slate-100 p-3 text-sm">{`${location.origin}\nEmail: ${form.email}\nPassword: ${form.password}`}</pre>
          </>
        ) : (
          <p className="text-sm">
            {form.name} can now sign in at {location.origin} with “Sign in with Microsoft”, using {form.email}.
          </p>
        )}
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={onClose} className="btn-primary">
            Done
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Add teammate" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="label">Name</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div>
          <label className="label">{microsoft ? 'Work email (their Microsoft 365 account)' : 'Email'}</label>
          <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        {microsoft && passwords && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withPassword} onChange={(e) => setWithPassword(e.target.checked)} />
            Also give a password (only if they can't use Microsoft sign-in)
          </label>
        )}
        {withPassword && (
          <div>
            <label className="label">Temporary password</label>
            <input className="input font-mono" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </div>
        )}
        <div>
          <label className="label">Role</label>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="MEMBER">Staff: works the LinkedIn accounts an admin assigns them</option>
            <option value="AUDITOR">Auditor: reads and exports the audit log only (no inbox, no accounts)</option>
            <option value="ADMIN">Admin: full access to everything, manages the team</option>
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!form.name || !form.email || (withPassword && form.password.length < 10)}
            className="btn-primary"
          >
            Add
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ResetModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [password] = useState(randomPassword());
  const [done, setDone] = useState(false);
  const reset = async () => {
    try {
      await api.patch(`/api/users/${user.id}`, { password });
      setDone(true);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal title={`Reset password · ${user.name}`} onClose={onClose}>
      {done ? (
        <pre className="rounded-md bg-slate-100 p-3 text-sm">New password: {password}</pre>
      ) : (
        <p className="text-sm">This signs {user.name} out everywhere and sets a new temporary password.</p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {done ? (
          <button type="button" onClick={onClose} className="btn-primary">
            Done
          </button>
        ) : (
          <>
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button type="button" onClick={reset} className="btn-danger">
              Reset
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

/** A teammate's Twenty user (owner of the Persons they add) and pod (master plan L2). */
function TwentyLinkModal({ user, pods, onClose }: { user: User; pods: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const members = useQuery({
    queryKey: ['crm-members'],
    queryFn: () => api.get<{ id: string; name: string | null; email: string | null }[]>('/api/crm/members'),
  });
  const [memberId, setMemberId] = useState(user.twentyMemberId ?? '');
  const [pod, setPod] = useState(user.pod ?? '');
  // Same email in Twenty: a likely match to offer first.
  const suggested = members.data?.find((m) => m.email && m.email === user.email?.toLowerCase());
  const save = async () => {
    try {
      await api.patch(`/api/users/${user.id}`, { twentyMemberId: memberId || null, pod: pod.trim() || null });
      toast('Saved', 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal title={`Twenty CRM · ${user.name}`} onClose={onClose}>
      <p className="mb-3 text-sm text-slate-600">
        Persons {user.name} adds to Twenty get them as owner and their pod. Binding to an existing Person fills these only where empty.
      </p>
      <label className="label">Their Twenty user</label>
      <select className="input" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
        <option value="">Not linked</option>
        {members.data?.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name ?? m.email ?? m.id}
            {m.email ? ` (${m.email})` : ''}
            {m.id === suggested?.id ? ' · same email' : ''}
          </option>
        ))}
      </select>
      {suggested && !memberId && (
        <button type="button" onClick={() => setMemberId(suggested.id)} className="mt-1 text-xs text-brand hover:underline">
          Use {suggested.name ?? suggested.email} (same email)
        </button>
      )}
      <label className="label mt-3">Pod</label>
      <input className="input" list="pods" value={pod} onChange={(e) => setPod(e.target.value)} placeholder="e.g. Pod A" maxLength={60} />
      <datalist id="pods">
        {pods.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="btn-ghost">
          Cancel
        </button>
        <button type="button" onClick={save} className="btn-primary">
          Save
        </button>
      </div>
    </Modal>
  );
}
