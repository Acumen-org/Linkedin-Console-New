import type { DirectoryInfo } from '@linkedin-console/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useMe } from '../../App';
import { PageScroll } from '../../components/Layout';
import { Avatar, Modal, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { fullTime } from '../../lib/format';
import { toast } from '../../lib/toast';
import type { User } from '../../types';

const Badge = ({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'blue' | 'red' }) => (
  <span
    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
      tone === 'blue' ? 'bg-blue-50 text-brand' : tone === 'red' ? 'bg-red-50 text-red-700' : 'bg-slate-100 text-slate-600'
    }`}
  >
    {children}
  </span>
);

/** How teammates sign in, and the Twilio console staff sync. */
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
          <span className="font-semibold">Twilio console staff list</span>
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
                ? 'Adds staff as members (no account access until granted) and disables leavers.'
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

export function TeamPage() {
  const me = useMe();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') });
  const directory = useQuery({ queryKey: ['directory'], queryFn: () => api.get<DirectoryInfo>('/api/users/directory') });
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);
  const passwordsUsed = !directory.data?.microsoft || directory.data.passwordSignin === 'on';

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
          <UserPlus size={16} /> Add teammate
        </button>
      </PageHeader>
      <p className="mb-4 text-sm text-slate-600">
        Teammates sign in to this app, never to LinkedIn. New members see no LinkedIn accounts until you grant access per account under
        Accounts → Team access. Admins always see everything.
      </p>
      {directory.data && <DirectoryCard info={directory.data} />}
      <div className="card divide-y divide-slate-100">
        {users.data?.map((u) => (
          <div key={u.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className={u.disabledAt ? 'opacity-50' : ''}>
              <Avatar name={u.name} size={38} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`font-semibold ${u.disabledAt ? 'text-slate-400' : ''}`}>{u.name}</span>
                {u.id === me.id && <span className="text-xs text-slate-500">(you)</span>}
                {u.microsoftLinked && <Badge tone="blue">Microsoft</Badge>}
                {u.hasPassword === false && !u.microsoftLinked && <Badge>Microsoft sign-in</Badge>}
                {u.source === 'staff_sync' && <Badge>From Twilio staff list</Badge>}
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
                <option value="MEMBER">Member</option>
                <option value="ADMIN">Admin</option>
              </select>
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
      {adding && <AddUserModal microsoft={!!directory.data?.microsoft} onClose={() => setAdding(false)} />}
      {resetting && <ResetModal user={resetting} onClose={() => setResetting(null)} />}
    </PageScroll>
  );
}

const randomPassword = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 55]).join('');

function AddUserModal({ microsoft, onClose }: { microsoft: boolean; onClose: () => void }) {
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
        {microsoft && (
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
            <option value="MEMBER">Member: works in the inbox with the access you grant</option>
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
