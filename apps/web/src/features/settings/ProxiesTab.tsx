// Admin-only proxy pool (Settings → Proxies), shown only when the pool is switched on (Integrations). Register a proxy
// once, then pin accounts to it from each account's settings. An account is never rotated or moved automatically — one
// account keeps one IP. Credentials are stored on the server but never shown here (addresses arrive masked).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Banner, Section, Toggle } from '../../components/ui';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { PoolProxy } from '../../types';

type TestResult = { ok: boolean; detail: string; ms: number };

export function ProxiesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['proxies'], queryFn: () => api.get<PoolProxy[]>('/api/proxies') });
  const refresh = () => qc.invalidateQueries({ queryKey: ['proxies'] });

  if (q.isLoading) return <p className="text-sm text-subtle">Loading…</p>;
  if (q.isError) return <Banner tone="danger">Couldn't load proxies: {(q.error as Error).message}</Banner>;
  const proxies = q.data ?? [];

  return (
    <div className="space-y-5">
      <Banner tone="gold">
        Register a proxy once, then pin accounts to it from each account's settings. An account is never rotated or moved automatically —
        one account keeps one IP, which is the safe behaviour for LinkedIn. Credentials are stored on the server and never shown here.
      </Banner>
      <AddProxy onAdded={refresh} />
      {proxies.length === 0 ? (
        <p className="text-sm text-subtle">No proxies yet — add one above.</p>
      ) : (
        <div className="space-y-3">
          {proxies.map((p) => (
            <ProxyCard key={p.id} proxy={p} onChanged={refresh} />
          ))}
        </div>
      )}
    </div>
  );
}

function AddProxy({ onAdded }: { onAdded: () => void }) {
  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [maxAccounts, setMax] = useState(1);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await api.post('/api/proxies', { label, address, maxAccounts });
      setLabel('');
      setAddress('');
      setMax(1);
      toast('Proxy added', 'success');
      onAdded();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Add a proxy"
      purpose="scheme://host:port — http(s) may carry user:pass. SOCKS with a username/password isn't supported (Chrome can't send it)."
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_1.6fr_auto_auto] sm:items-end">
        <div>
          <label className="label">Name</label>
          <input className="input" placeholder="e.g. US-East 1" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div>
          <label className="label">Address</label>
          <input className="input" placeholder="http://user:pass@host:port" value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div>
          <label className="label">Max accounts</label>
          <input
            className="input w-24"
            type="number"
            min={1}
            max={50}
            value={maxAccounts}
            onChange={(e) => setMax(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
          />
        </div>
        <button className="btn-primary" disabled={busy || !label.trim() || !address.trim()} onClick={add}>
          {busy ? 'Adding…' : 'Add proxy'}
        </button>
      </div>
    </Section>
  );
}

function ProxyCard({ proxy, onChanged }: { proxy: PoolProxy; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  const full = proxy.inUse >= proxy.maxAccounts;
  const edge = proxy.disabled ? 'spine spine-warning' : full ? 'spine' : 'spine spine-success';
  return (
    <div className={`card p-4 ${edge}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{proxy.label}</span>
            {proxy.disabled && <Badge tone="warning">Disabled</Badge>}
            {full && !proxy.disabled && <Badge tone="gold">Full</Badge>}
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted">{proxy.address}</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-medium tabular-nums">
            {proxy.inUse} / {proxy.maxAccounts} account{proxy.maxAccounts === 1 ? '' : 's'}
          </div>
          <div className="mt-1 h-1.5 w-32 overflow-hidden rounded-full bg-surface-muted">
            <div className="h-full rounded-full bg-gold" style={{ width: `${Math.min(100, (proxy.inUse / proxy.maxAccounts) * 100)}%` }} />
          </div>
        </div>
      </div>
      {test && (
        <div className={`mt-3 text-sm ${test.ok ? 'text-success-ink' : 'text-danger-ink'}`}>
          {test.ok ? '✓' : '✗'} {test.detail} ({test.ms} ms)
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          className="btn-outline"
          disabled={!!busy}
          onClick={() =>
            run('test', async () => {
              setTest(await api.post<TestResult>(`/api/proxies/${proxy.id}/test`));
            })
          }
        >
          {busy === 'test' ? 'Testing…' : 'Test'}
        </button>
        <label className="flex items-center gap-2 text-sm text-muted">
          <Toggle
            checked={!proxy.disabled}
            disabled={!!busy}
            label="Enabled"
            onChange={(on) =>
              run('disable', async () => {
                await api.patch(`/api/proxies/${proxy.id}`, { disabled: !on });
                onChanged();
              })
            }
          />
          {proxy.disabled ? 'Disabled' : 'Enabled'}
        </label>
        <div className="flex-1" />
        <button
          className="btn-danger"
          disabled={!!busy || proxy.inUse > 0}
          title={proxy.inUse > 0 ? 'Move its accounts off it first' : 'Remove this proxy'}
          onClick={() =>
            run('delete', async () => {
              await api.del(`/api/proxies/${proxy.id}`);
              toast('Proxy removed', 'success');
              onChanged();
            })
          }
        >
          Remove
        </button>
      </div>
    </div>
  );
}
