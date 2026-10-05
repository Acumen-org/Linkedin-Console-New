import { createContext, useContext, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import type { User } from './types';
import { connectRealtime } from './realtime';
import { Layout } from './components/Layout';
import { LoginPage, SetupPage } from './pages/Auth';
import { InboxPage } from './pages/Inbox';
import { AccountsPage } from './pages/Accounts';
import { ConnectPage } from './pages/Connect';
import { LivePage } from './pages/Live';
import { ConnectionsPage } from './pages/Connections';
import { TeamPage } from './pages/Team';
import { AuditPage } from './pages/Audit';
import { ProfilePage } from './pages/Profile';

const MeContext = createContext<User | null>(null);
export const useMe = () => useContext(MeContext)!;
export const isAdmin = (u: User | null) => !!u && u.role !== 'MEMBER';

export function App() {
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api.get<{ needsSetup: boolean }>('/api/setup') });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: User }>('/api/me').then((r) => r.user).catch((e) => { if (e instanceof ApiError && e.status === 401) return null; throw e; }),
    enabled: setup.data?.needsSetup === false,
  });

  useEffect(() => { if (me.data) connectRealtime(qc); }, [me.data, qc]);

  if (setup.isLoading || (setup.data?.needsSetup === false && me.isLoading)) {
    return <div className="flex h-full items-center justify-center text-slate-500">Loading…</div>;
  }
  if (setup.isError) return <div className="flex h-full items-center justify-center text-red-600">Can't reach the server.</div>;
  if (setup.data?.needsSetup) return <SetupPage />;
  if (!me.data) return <LoginPage />;

  return (
    <MeContext.Provider value={me.data}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Navigate to="/inbox" replace />} />
          <Route path="/inbox" element={<InboxPage />} />
          <Route path="/inbox/:conversationId" element={<InboxPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/accounts/:accountId/connect" element={<ConnectPage />} />
          <Route path="/accounts/:accountId/live" element={<LivePage />} />
          <Route path="/connections" element={<ConnectionsPage />} />
          <Route path="/connections/:accountId" element={<ConnectionsPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/audit" element={<AuditPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="*" element={<Navigate to="/inbox" replace />} />
        </Route>
      </Routes>
    </MeContext.Provider>
  );
}
