import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Modal, StatusBadge } from '../../components/ui';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { Account, AccountStatus, Level, User } from '../../types';

const LEVELS: { value: Level | ''; label: string }[] = [
  { value: '', label: 'No access' },
  { value: 'READ', label: 'Read: view chats' },
  { value: 'REPLY', label: 'Reply: send messages, start chats' },
  { value: 'FULL', label: 'Full: also settings and Live control' },
];

interface Access {
  accountId: string;
  label: string;
  displayName: string | null;
  status: AccountStatus;
  level: Level | null;
}

const confirmFull = (who: string) =>
  confirm(`Full access lets ${who} drive the LinkedIn browser and change account settings. Give Full access?`);

/** One staff member's LinkedIn accounts: tick what they work on and at which level. */
export function StaffAccessModal({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const access = useQuery({ queryKey: ['user-access', user.id], queryFn: () => api.get<Access[]>(`/api/users/${user.id}/access`) });
  const [levels, setLevels] = useState<Record<string, Level | ''>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (access.data) setLevels(Object.fromEntries(access.data.map((a) => [a.accountId, a.level ?? ''])));
  }, [access.data]);

  const changed = access.data?.filter((a) => (a.level ?? '') !== (levels[a.accountId] ?? '')) ?? [];
  const save = async () => {
    const addsFull = changed.some((a) => levels[a.accountId] === 'FULL');
    if (addsFull && !confirmFull(user.name)) return;
    setSaving(true);
    try {
      await api.put(
        `/api/users/${user.id}/access`,
        changed.map((a) => ({ accountId: a.accountId, level: levels[a.accountId] || null })),
      );
      toast(`Access updated for ${user.name}`, 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['user-access', user.id] });
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setSaving(false);
    }
  };

  return (
    <Modal title={`LinkedIn accounts · ${user.name}`} onClose={onClose} wide>
      <p className="mb-3 text-sm text-slate-600">
        {user.name} sees only the accounts given here. Changes apply at once, also if they are signed in, and are recorded in the audit log.
      </p>
      {access.data?.length === 0 && <div className="py-6 text-center text-sm text-slate-500">No LinkedIn accounts connected yet.</div>}
      <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
        {access.data?.map((a) => (
          <div key={a.accountId} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-medium">
                {a.label} <StatusBadge status={a.status} />
              </div>
              {a.displayName && <div className="truncate text-xs text-slate-500">{a.displayName}</div>}
            </div>
            <select
              className="rounded-md border border-slate-300 px-2 py-1 text-sm"
              value={levels[a.accountId] ?? ''}
              onChange={(e) => setLevels({ ...levels, [a.accountId]: e.target.value as Level | '' })}
            >
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="btn-ghost">
          Cancel
        </button>
        <button type="button" onClick={save} disabled={saving || !changed.length} className="btn-primary">
          Save{changed.length ? ` (${changed.length})` : ''}
        </button>
      </div>
    </Modal>
  );
}

/** Several staff members at once: the chosen level (or no access) on every chosen account. */
export function BulkAssignModal({ users, onClose, onDone }: { users: User[]; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [level, setLevel] = useState<Level | ''>('REPLY');
  const [saving, setSaving] = useState(false);
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const who = users.length === 1 ? users[0].name : `${users.length} staff members`;

  const apply = async () => {
    if (level === 'FULL' && !confirmFull(who)) return;
    setSaving(true);
    try {
      const r = await api.post<{ changed: number }>('/api/users/access/bulk', {
        userIds: users.map((u) => u.id),
        accountIds: [...picked],
        level: level || null,
      });
      toast(r.changed ? `Updated ${r.changed} assignment${r.changed === 1 ? '' : 's'}` : 'Nothing to change', 'success');
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['user-access'] });
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
      setSaving(false);
    }
  };

  return (
    <Modal title={`Assign accounts · ${who}`} onClose={onClose} wide>
      <div className="mb-3 text-sm text-slate-600">{users.map((u) => u.name).join(', ')}</div>
      <label className="label">LinkedIn accounts</label>
      <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-md border border-slate-200">
        {accounts.data?.map((a) => (
          <label key={a.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
            <input type="checkbox" checked={picked.has(a.id)} onChange={() => toggle(a.id)} />
            <span className="flex-1 font-medium">{a.label}</span>
            <StatusBadge status={a.status} />
          </label>
        ))}
      </div>
      <div className="mt-3">
        <label className="label">Access</label>
        <select className="input" value={level} onChange={(e) => setLevel(e.target.value as Level | '')}>
          {LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.value ? l.label : 'Remove access'}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="btn-ghost">
          Cancel
        </button>
        <button type="button" onClick={apply} disabled={saving || !picked.size} className="btn-primary">
          Apply to {picked.size} account{picked.size === 1 ? '' : 's'}
        </button>
      </div>
    </Modal>
  );
}
