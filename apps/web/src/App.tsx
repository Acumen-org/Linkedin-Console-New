import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router';
import { Layout } from './components/Layout';
import { LoginPage, SetupPage } from './features/AuthPages';
import { AccountsPage } from './features/accounts/AccountsPage';
import { ConnectPage } from './features/accounts/ConnectPage';
import { LivePage } from './features/accounts/LivePage';
import { InboxPage } from './features/inbox/InboxPage';
import { ConnectionsPage } from './features/network/ConnectionsPage';
import { AuditPage } from './features/settings/AuditPage';
import { ProfilePage } from './features/settings/ProfilePage';
import { SettingsPage } from './features/settings/SettingsPage';
import { TeamPage } from './features/settings/TeamPage';
import { ApiError, api, setSignedOutHandler } from './lib/api';
import { connectRealtime, disconnectRealtime } from './lib/realtime';
import type { User } from './types';

const MeContext = createContext<User | null>(null);
export const useMe = () => useContext(MeContext)!;
export const isAdmin = (u: User | null) => !!u && u.role !== 'MEMBER';

export function App() {
  const qc = useQueryClient();
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api.get<{ needsSetup: boolean }>('/api/setup') });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api
        .get<{ user: User }>('/api/me')
        .then((r) => r.user)
        .catch((e) => {
          if (e instanceof ApiError && e.status === 401) return null;
          throw e;
        }),
    enabled: setup.data?.needsSetup === false,
  });

  // Notification clicks (service worker) open the conversation inside the running app.
  const navigate = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type !== 'navigate') return;
      const url = new URL(e.data.url, location.origin);
      if (url.origin === location.origin) navigate(url.pathname + url.search);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  useEffect(() => {
    const signedOut = () => {
      disconnectRealtime();
      qc.setQueryData(['me'], null);
    };
    setSignedOutHandler(signedOut);
    if (me.data) connectRealtime(qc, signedOut);
  }, [me.data, qc]);

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
          <Route path="/settings" element={<Navigate to="/settings/templates" replace />} />
          <Route path="/settings/:tab" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/inbox" replace />} />
        </Route>
      </Routes>
    </MeContext.Provider>
  );
}
