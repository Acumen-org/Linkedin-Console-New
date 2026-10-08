import { LOGIN_ERRORS, type LoginError } from '@linkedin-console/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api } from '../lib/api';

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand font-bold text-white">LC</div>
          <span className="text-2xl font-semibold text-brand">LinkedIn Console</span>
        </div>
        <div className="card p-6 shadow-sm">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mb-5 mt-1 text-sm text-slate-500">{subtitle}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function useSubmit(fn: () => Promise<unknown>) {
  const qc = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await fn();
      await qc.invalidateQueries();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { submit, error, busy };
}

/** Microsoft's four-square mark. */
const MicrosoftLogo = () => (
  <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
    <rect x="1" y="1" width="9" height="9" fill="#f25022" />
    <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
    <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
    <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
  </svg>
);

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const methods = useQuery({
    queryKey: ['auth-methods'],
    queryFn: () => api.get<{ microsoft: boolean; password: 'on' | 'owner' }>('/api/auth/methods'),
  });
  // With company sign-in and owner-only passwords, the password form is the owner's emergency access.
  const [showPassword, setShowPassword] = useState(false);
  // Only known codes are shown (with our own wording): the URL can't put arbitrary text on this page.
  const code = new URLSearchParams(location.search).get('error') ?? '';
  const redirectError = Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code as LoginError] : null;
  const { submit, error, busy } = useSubmit(() => api.post('/api/auth/login', { email, password }));
  const microsoft = !!methods.data?.microsoft;
  const passwordForm = !microsoft || methods.data?.password === 'on' || showPassword;
  return (
    <Shell title="Sign in" subtitle="Your team's unified LinkedIn inbox">
      {redirectError && <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{redirectError}</div>}
      {microsoft && (
        <a href="/api/auth/microsoft" className="btn-outline mb-3 w-full justify-center py-2">
          <MicrosoftLogo /> Sign in with Microsoft
        </a>
      )}
      {microsoft && !passwordForm && (
        <button type="button" onClick={() => setShowPassword(true)} className="w-full text-center text-xs text-slate-500 hover:underline">
          Owner emergency sign-in
        </button>
      )}
      {microsoft && passwordForm && <div className="mb-3 text-center text-xs text-slate-400">or with a password</div>}
      {passwordForm && (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          <button className="btn-primary w-full py-2" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      )}
    </Shell>
  );
}

export function SetupPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { submit, error, busy } = useSubmit(() => api.post('/api/setup', { name, email, password }));
  return (
    <Shell title="Welcome 👋" subtitle="Create the owner account. You can invite your team afterwards.">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Your name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="label">Password (min. 10 characters)</label>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
        <button className="btn-primary w-full py-2" disabled={busy}>
          {busy ? 'Creating…' : 'Create owner account'}
        </button>
      </form>
    </Shell>
  );
}
