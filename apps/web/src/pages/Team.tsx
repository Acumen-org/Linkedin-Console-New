import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { api } from '../api';
import type { User } from '../types';
import { useMe } from '../App';
import { PageScroll } from '../components/Layout';
import { Avatar, Modal, PageHeader } from '../components/ui';
import { toast } from '../toast';

export function TeamPage() {
  const me = useMe();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/api/users') });
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<User | null>(null);

  const update = async (u: User, body: Record<string, unknown>, ok: string) => {
    try { await api.patch(`/api/users/${u.id}`, body); toast(ok, 'success'); qc.invalidateQueries({ queryKey: ['users'] }); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <PageScroll>
      <PageHeader title="Team"><button onClick={() => setAdding(true)} className="btn-primary"><UserPlus size={16} /> Add teammate</button></PageHeader>
      <p className="mb-4 text-sm text-slate-600">
        Teammates log in to this app, never to LinkedIn. New teammates get default access to every connected account. Fine-tune it per account under Accounts → Team access.
      </p>
      <div className="card divide-y divide-slate-100">
        {users.data?.map((u) => (
          <div key={u.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${u.disabledAt ? 'opacity-50' : ''}`}>
            <Avatar name={u.name} size={38} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{u.name} {u.id === me.id && <span className="text-xs text-slate-500">(you)</span>}</div>
              <div className="text-sm text-slate-600">{u.email}</div>
            </div>
            {u.role === 'OWNER' ? <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-brand">Owner</span> : (
              <select className="rounded-md border border-slate-300 px-2 py-1 text-sm" value={u.role} disabled={u.id === me.id}
                onChange={(e) => update(u, { role: e.target.value }, 'Role updated')}>
                <option value="MEMBER">Member</option><option value="ADMIN">Admin</option>
              </select>
            )}
            {u.role !== 'OWNER' && u.id !== me.id && (
              <>
                <button onClick={() => setResetting(u)} className="btn-ghost text-xs">Reset password</button>
                <button onClick={() => update(u, { disabled: !u.disabledAt }, u.disabledAt ? 'Enabled' : 'Disabled')} className="btn-ghost text-xs">{u.disabledAt ? 'Enable' : 'Disable'}</button>
              </>
            )}
          </div>
        ))}
      </div>
      {adding && <AddUserModal onClose={() => setAdding(false)} />}
      {resetting && <ResetModal user={resetting} onClose={() => setResetting(null)} />}
    </PageScroll>
  );
}

const randomPassword = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 55]).join('');

function AddUserModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: '', email: '', password: randomPassword(), role: 'MEMBER' });
  const [done, setDone] = useState(false);
  const save = async () => {
    try { await api.post('/api/users', form); qc.invalidateQueries({ queryKey: ['users'] }); setDone(true); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  if (done) {
    return (
      <Modal title="Teammate added" onClose={onClose}>
        <p className="text-sm">Share these login details with {form.name} privately. They can change the password under their profile.</p>
        <pre className="mt-3 rounded-md bg-slate-100 p-3 text-sm">{`${location.origin}\nEmail: ${form.email}\nPassword: ${form.password}`}</pre>
        <div className="mt-4 flex justify-end"><button onClick={onClose} className="btn-primary">Done</button></div>
      </Modal>
    );
  }
  return (
    <Modal title="Add teammate" onClose={onClose}>
      <div className="space-y-3">
        <div><label className="label">Name</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div><label className="label">Email</label><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
        <div><label className="label">Temporary password</label><input className="input font-mono" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
        <div><label className="label">Role</label>
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="MEMBER">Member: works in the inbox with the access you grant</option>
            <option value="ADMIN">Admin: full access to everything, manages the team</option>
          </select>
        </div>
        <div className="flex justify-end gap-2"><button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={save} disabled={!form.name || !form.email || form.password.length < 10} className="btn-primary">Add</button></div>
      </div>
    </Modal>
  );
}

function ResetModal({ user, onClose }: { user: User; onClose: () => void }) {
  const [password] = useState(randomPassword());
  const [done, setDone] = useState(false);
  const reset = async () => {
    try { await api.patch(`/api/users/${user.id}`, { password }); setDone(true); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <Modal title={`Reset password · ${user.name}`} onClose={onClose}>
      {done ? <pre className="rounded-md bg-slate-100 p-3 text-sm">New password: {password}</pre>
        : <p className="text-sm">This logs {user.name} out everywhere and sets a new temporary password.</p>}
      <div className="mt-4 flex justify-end gap-2">
        {done ? <button onClick={onClose} className="btn-primary">Done</button> : <><button onClick={onClose} className="btn-ghost">Cancel</button><button onClick={reset} className="btn-danger">Reset</button></>}
      </div>
    </Modal>
  );
}
