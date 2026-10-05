import type { ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, Link2, Users, ShieldCheck, LogOut, Contact } from 'lucide-react';
import { api } from '../api';
import { isAdmin, useMe } from '../App';
import type { Account } from '../types';
import { disconnectRealtime } from '../realtime';
import { Avatar } from './ui';

export function Layout() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/api/accounts') });
  const unread = accounts.data?.reduce((n, a) => n + (a.unread ?? 0), 0) ?? 0;
  const attention = accounts.data?.filter((a) => a.status === 'NEEDS_ATTENTION' && a.level === 'FULL').length ?? 0;

  const logout = async () => {
    await api.post('/api/auth/logout');
    disconnectRealtime();
    qc.clear();
    nav('/');
    window.location.reload();
  };

  const link = ({ isActive }: { isActive: boolean }) =>
    `flex flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[11px] font-medium relative ${isActive ? 'text-brand bg-blue-50' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100'}`;

  return (
    <div className="flex h-full">
      <nav className="flex w-[76px] shrink-0 flex-col items-center gap-1 border-r border-slate-200 bg-white py-3">
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">LU</div>
        <NavLink to="/inbox" className={link}>
          <Inbox size={22} /> Inbox
          {unread > 0 && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-red-600 px-1 text-[10px] leading-4 text-white">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
        <NavLink to="/accounts" className={link}>
          <Link2 size={22} /> Accounts
          {attention > 0 && <span className="absolute right-2 top-1 h-2.5 w-2.5 rounded-full bg-red-600" />}
        </NavLink>
        <NavLink to="/connections" className={link}><Contact size={22} /> Network</NavLink>
        {isAdmin(me) && <NavLink to="/team" className={link}><Users size={22} /> Team</NavLink>}
        {isAdmin(me) && <NavLink to="/audit" className={link}><ShieldCheck size={22} /> Audit</NavLink>}
        <div className="flex-1" />
        <NavLink to="/profile" className={link} title={me.name}><Avatar name={me.name} size={28} /></NavLink>
        <button onClick={logout} className="flex flex-col items-center gap-0.5 rounded-lg px-2 py-2 text-[11px] text-slate-500 hover:bg-slate-100" title="Log out">
          <LogOut size={20} /> Log out
        </button>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AccountAlerts accounts={accounts.data ?? []} />
        <div className="min-h-0 flex-1"><Outlet /></div>
      </main>
    </div>
  );
}

/** Banner for accounts that need a human: re-login or a stopped browser. */
function AccountAlerts({ accounts }: { accounts: Account[] }) {
  const me = useMe();
  const broken = accounts.filter((a) => (a.status === 'NEEDS_ATTENTION' || a.status === 'OFFLINE') && (a.level === 'FULL' || a.ownerUserId === me.id));
  if (!broken.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-red-200 bg-red-50 px-4 py-2 text-sm text-red-800">
      {broken.map((a) => (
        <span key={a.id} className="flex items-center gap-2">
          <b>{a.label}</b> {a.status === 'NEEDS_ATTENTION' ? 'needs you to log in again; sending is paused.' : "browser is offline; messages aren't syncing."}
          <NavLink to={a.status === 'NEEDS_ATTENTION' ? `/accounts/${a.id}/connect` : '/accounts'} className="font-semibold underline">
            {a.status === 'NEEDS_ATTENTION' ? 'Log in' : 'Open accounts'}
          </NavLink>
        </span>
      ))}
    </div>
  );
}

export function PageScroll({ children }: { children: ReactNode }) {
  return <div className="h-full overflow-y-auto"><div className="mx-auto max-w-5xl p-6">{children}</div></div>;
}

