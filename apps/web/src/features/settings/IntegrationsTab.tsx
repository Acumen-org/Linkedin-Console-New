// Admin-only Twenty CRM + staff-sync settings (Settings → Twenty CRM). Reads/writes /api/integrations; secrets are
// write-only (shown as "set", never returned). Mirrors the server config in lib/integrations.ts.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';

interface IntegrationView {
  credentialsEnabled: boolean;
  crmSync: boolean;
  crmAutoBind: boolean;
  crmAutoCreate: boolean;
  crmFuzzyBind: boolean;
  searchEnabled: boolean;
  twenty: { url: string; webUrl: string; ownerField: string; podField: string; apiKeySet: boolean } | null;
  microsoft: { tenantId: string; clientId: string; clientSecretSet: boolean } | null;
  staffSync: { mode: 'off' | 'disable' | 'provision'; source: 'twilio' | 'twenty' };
}
interface CrmStatus {
  enabled: boolean;
  people?: number;
  needsBinding?: number;
  synced24h?: number;
  failed?: number;
  conversationObject?: boolean;
  pendingRecords?: number;
  last?: { ok: boolean; error?: string } | null;
}
interface StaffStatus {
  ok?: boolean;
  error?: string;
  staff?: number;
  linked?: number;
  provisioned?: number;
}
interface IntegrationsResp {
  settings: IntegrationView;
  crm: CrmStatus;
  staff: StaffStatus | null;
}

const field = 'w-full rounded-lg border border-border-strong px-3 py-2 text-sm focus:border-brand focus:outline-none';

export function IntegrationsTab() {
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api.get<IntegrationsResp>('/api/integrations') });
  const [version, setVersion] = useState(0);
  if (q.isLoading) return <p className="text-sm text-subtle">Loading…</p>;
  if (!q.data) return <p className="text-sm text-red-600 dark:text-red-400">Couldn't load integration settings.</p>;
  return (
    <IntegrationsForm
      key={version}
      data={q.data}
      onChanged={() => {
        setVersion((v) => v + 1);
        q.refetch();
      }}
    />
  );
}

function IntegrationsForm({ data, onChanged }: { data: IntegrationsResp; onChanged: () => void }) {
  const s = data.settings;
  const [busy, setBusy] = useState<string | null>(null);
  const [twUrl, setTwUrl] = useState(s.twenty?.url ?? '');
  const [twKey, setTwKey] = useState('');
  const [twWeb, setTwWeb] = useState(s.twenty?.webUrl ?? '');
  const [owner, setOwner] = useState(s.twenty?.ownerField ?? 'assignedTo');
  const [pod, setPod] = useState(s.twenty?.podField ?? 'pod');
  const [msTenant, setMsTenant] = useState(s.microsoft?.tenantId ?? '');
  const [msClient, setMsClient] = useState(s.microsoft?.clientId ?? '');
  const [msSecret, setMsSecret] = useState('');
  const [staffMode, setStaffMode] = useState(s.staffSync.mode);
  const [staffSource, setStaffSource] = useState(s.staffSync.source);
  const [fieldsReport, setFieldsReport] = useState<string | null>(null);

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
  const put = (body: unknown) => api.put('/api/integrations', body);

  return (
    <div className="space-y-6">
      {!s.credentialsEnabled && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
          Saving the Twenty API key or Microsoft secret here needs <code>CREDENTIALS_KEY</code> set on the server (a base64 32-byte key).
          Until then keep those secrets in the server environment; the toggles and field names below still work.
        </div>
      )}

      <section className="card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold">Twenty connection</h3>
          <span className={`text-xs ${s.twenty ? 'text-emerald-700 dark:text-emerald-400' : 'text-subtle'}`}>
            {s.twenty ? 'Configured' : 'Not configured'}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-muted">GraphQL API URL</span>
            <input className={field} value={twUrl} onChange={(e) => setTwUrl(e.target.value)} placeholder="https://your-twenty/graphql" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted">
              API key {s.twenty?.apiKeySet && <em className="text-subtle">(set — blank keeps it)</em>}
            </span>
            <input
              className={field}
              type="password"
              value={twKey}
              onChange={(e) => setTwKey(e.target.value)}
              placeholder={s.twenty?.apiKeySet ? '••••••••' : 'paste the Twenty API key'}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted">Web URL (for links; optional)</span>
            <input className={field} value={twWeb} onChange={(e) => setTwWeb(e.target.value)} placeholder="https://app.your-twenty" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-muted">Owner field</span>
              <input className={field} value={owner} onChange={(e) => setOwner(e.target.value)} />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Pod field</span>
              <input className={field} value={pod} onChange={(e) => setPod(e.target.value)} />
            </label>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="btn-primary"
            disabled={!!busy}
            onClick={() =>
              run('save-twenty', async () => {
                await put({ twenty: { url: twUrl, apiKey: twKey || undefined, webUrl: twWeb, ownerField: owner, podField: pod } });
                toast('Saved', 'success');
                onChanged();
              })
            }
          >
            Save connection
          </button>
          <button
            className="btn-ghost"
            disabled={!!busy}
            onClick={() =>
              run('test', async () => {
                const r = await api.post<{ ok: boolean; members?: number; error?: string }>('/api/integrations/test');
                toast(r.ok ? `Connected — ${r.members} workspace members` : `Failed: ${r.error}`, r.ok ? 'success' : 'error');
              })
            }
          >
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {s.twenty && (
            <button
              className="btn-ghost text-red-600 dark:text-red-400"
              disabled={!!busy}
              onClick={() =>
                run('disable-twenty', async () => {
                  if (!confirm('Disconnect Twenty? The CRM and staff-from-Twenty syncs will stop.')) return;
                  await put({ twenty: { disable: true } });
                  toast('Disconnected', 'success');
                  onChanged();
                })
              }
            >
              Disconnect
            </button>
          )}
        </div>
      </section>

      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">LinkedIn people search</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.searchEnabled}
              disabled={!!busy}
              onChange={(e) =>
                run('search', async () => {
                  await put({ searchEnabled: e.target.checked });
                  toast(e.target.checked ? 'People search on' : 'People search off', 'success');
                  onChanged();
                })
              }
            />
            <span>{s.searchEnabled ? 'On' : 'Off'}</span>
          </label>
        </div>
        <p className="text-sm text-muted">
          Lets the team use the <b>Search</b> section to find people on LinkedIn you're not connected to, through a connected account's
          session. Searches are paced and capped per account per day. Off by default — automated search is the highest-risk action for an
          account, so turn it on deliberately.
        </p>
      </section>

      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">CRM field sync</h3>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.crmSync}
              disabled={!!busy || !s.twenty}
              onChange={(e) =>
                run('crm', async () => {
                  await put({ crmSync: e.target.checked });
                  toast(e.target.checked ? 'CRM sync on' : 'CRM sync off', 'success');
                  onChanged();
                })
              }
            />
            <span>{s.crmSync ? 'On' : 'Off'}</span>
          </label>
        </div>
        <p className="mb-3 text-sm text-muted">
          Writes each bound prospect's LinkedIn status and activity to their Twenty Person. Needs the Person fields below.
        </p>
        <label className="mb-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={s.crmAutoBind}
            disabled={!!busy || !s.twenty || !s.crmSync}
            onChange={(e) =>
              run('autobind', async () => {
                await put({ crmAutoBind: e.target.checked });
                toast(e.target.checked ? 'Auto-bind on' : 'Auto-bind off (manual binding)', 'success');
                onChanged();
              })
            }
          />
          <span className="text-muted">
            <b>Auto-bind matches.</b> When a replier clearly matches one Twenty Person (same LinkedIn link), bind them automatically. Off:
            binding to existing People is <b>manual</b> — a matching replier waits under "Needs CRM binding" for a teammate to bind them.
          </span>
        </label>
        <label className="mb-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={s.crmAutoCreate}
            disabled={!!busy || !s.twenty || !s.crmSync}
            onChange={(e) =>
              run('autocreate', async () => {
                await put({ crmAutoCreate: e.target.checked });
                toast(e.target.checked ? 'Auto-create on' : 'Auto-create off', 'success');
                onChanged();
              })
            }
          />
          <span className="text-muted">
            <b>Auto-create people in Twenty.</b> When a prospect replies and nobody in Twenty has their LinkedIn profile, create a new
            Person for them and bind automatically. Only ever when no Person already matches their link, so it never makes a duplicate. Off:
            those repliers wait under "Needs CRM binding" for someone to add them by hand.
          </span>
        </label>
        <label className="mb-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={s.crmFuzzyBind}
            disabled={!!busy || !s.twenty || !s.crmSync}
            onChange={(e) =>
              run('fuzzybind', async () => {
                await put({ crmFuzzyBind: e.target.checked });
                toast(e.target.checked ? 'Fuzzy auto-bind on' : 'Fuzzy auto-bind off', 'success');
                onChanged();
              })
            }
          />
          <span className="text-muted">
            <b>Confidence auto-bind.</b> When a replier has no single exact-link match, auto-bind them to a <i>strong</i> fuzzy match (exact
            name + same company/role) when there's one clear winner; weaker or tied matches wait under "Needs CRM binding". Exact-link
            binding always happens regardless. A wrong fuzzy bind is reversible — review them under "CRM bindings".
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn-ghost"
            disabled={!!busy || !s.twenty}
            onClick={() =>
              run('check-fields', async () => {
                const r = await api.post<{ ok: boolean; missing?: number; error?: string }>('/api/integrations/fields', { apply: false });
                if (!r.ok) return toast(r.error ?? 'Failed', 'error');
                setFieldsReport(
                  r.missing === 0 ? 'All Twenty fields are set up.' : `${r.missing} missing — press "Set up fields" to add them.`,
                );
              })
            }
          >
            Check fields
          </button>
          <button
            className="btn-ghost"
            disabled={!!busy || !s.twenty}
            onClick={() =>
              run('apply-fields', async () => {
                const r = await api.post<{ ok: boolean; items?: { status: string }[]; error?: string }>('/api/integrations/fields', {
                  apply: true,
                });
                if (!r.ok) return toast(r.error ?? 'Failed', 'error');
                const added = r.items?.filter((i) => i.status === 'added').length ?? 0;
                setFieldsReport(added ? `Added ${added} field(s)/object.` : 'Everything was already set up.');
                toast('Twenty fields set up', 'success');
              })
            }
          >
            {busy === 'apply-fields' ? 'Setting up…' : 'Set up fields'}
          </button>
        </div>
        {fieldsReport && <p className="mt-2 text-sm text-foreground">{fieldsReport}</p>}
        {data.crm?.enabled && (
          <div className="mt-3 text-xs text-subtle">
            {data.crm.people ?? 0} bound · {data.crm.needsBinding ?? 0} need binding · {data.crm.synced24h ?? 0} synced (24h)
            {data.crm.failed ? ` · ${data.crm.failed} failed` : ''}
            {data.crm.pendingRecords ? ` · ${data.crm.pendingRecords} not yet in Twenty` : ''}
            {data.crm.last && !data.crm.last.ok && (
              <span className="text-red-600 dark:text-red-400"> · last error: {data.crm.last.error}</span>
            )}
          </div>
        )}
        {data.crm?.enabled && data.crm.conversationObject === false && (
          <p className="mt-2 rounded-md bg-amber-50 dark:bg-amber-500/10 p-2 text-sm text-amber-800 dark:text-amber-200">
            The “LinkedIn conversations” object isn’t set up in Twenty, so bound prospects won’t appear there. Press{' '}
            <strong>Set up fields</strong> above to add it, then they’ll sync within a minute.
          </p>
        )}
      </section>

      <section className="card p-4">
        <h3 className="mb-2 font-semibold">Staff / member sync</h3>
        <p className="mb-3 text-sm text-muted">
          Keep the console's team in step with the source. <b>Link &amp; remove leavers</b> links people and disables anyone removed;{' '}
          <b>Provision</b> also creates a Member for each active person (Microsoft sign-in, no account access until granted).
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-muted">Mode</span>
            <select className={field} value={staffMode} onChange={(e) => setStaffMode(e.target.value as typeof staffMode)}>
              <option value="off">Off</option>
              <option value="disable">Link &amp; remove leavers</option>
              <option value="provision">Provision members</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted">Source</span>
            <select className={field} value={staffSource} onChange={(e) => setStaffSource(e.target.value as typeof staffSource)}>
              <option value="twenty">Twenty workspace</option>
              <option value="twilio">Twilio console</option>
            </select>
          </label>
        </div>
        <button
          className="btn-primary mt-3"
          disabled={!!busy}
          onClick={() =>
            run('save-staff', async () => {
              await put({ staffSync: { mode: staffMode, source: staffSource } });
              toast('Saved', 'success');
              onChanged();
            })
          }
        >
          Save staff sync
        </button>
        {data.staff && (
          <div className="mt-3 text-xs text-subtle">
            Last run:{' '}
            {data.staff.ok ? (
              `${data.staff.staff ?? 0} staff, ${data.staff.linked ?? 0} linked, ${data.staff.provisioned ?? 0} provisioned`
            ) : (
              <span className="text-red-600 dark:text-red-400">failed: {data.staff.error}</span>
            )}
          </div>
        )}
      </section>

      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Microsoft sign-in</h3>
          <span className={`text-xs ${s.microsoft ? 'text-emerald-700 dark:text-emerald-400' : 'text-subtle'}`}>
            {s.microsoft ? 'Configured' : 'Not configured'}
          </span>
        </div>
        <p className="mb-3 text-sm text-muted">
          Required to provision staff (they have no password). In Azure, register a Web app with redirect URI{' '}
          <code>&lt;this console&gt;/api/auth/microsoft/callback</code> and scopes <code>openid profile email</code>.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="text-sm">
            <span className="mb-1 block text-muted">Tenant ID</span>
            <input className={field} value={msTenant} onChange={(e) => setMsTenant(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted">Client ID</span>
            <input className={field} value={msClient} onChange={(e) => setMsClient(e.target.value)} />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-muted">
              Client secret {s.microsoft?.clientSecretSet && <em className="text-subtle">(set)</em>}
            </span>
            <input
              className={field}
              type="password"
              value={msSecret}
              onChange={(e) => setMsSecret(e.target.value)}
              placeholder={s.microsoft?.clientSecretSet ? '••••••••' : ''}
            />
          </label>
        </div>
        <button
          className="btn-primary mt-3"
          disabled={!!busy}
          onClick={() =>
            run('save-ms', async () => {
              await put({ microsoft: { tenantId: msTenant, clientId: msClient, clientSecret: msSecret || undefined } });
              toast('Saved', 'success');
              onChanged();
            })
          }
        >
          Save Microsoft sign-in
        </button>
      </section>

      <div>
        <button
          className="btn-ghost"
          disabled={!!busy}
          onClick={() =>
            run('sync', async () => {
              await api.post('/api/integrations/sync');
              toast('Sync started', 'success');
              onChanged();
            })
          }
        >
          {busy === 'sync' ? 'Syncing…' : 'Sync now'}
        </button>
      </div>

      <ApiKeysSection />
    </div>
  );
}

interface ApiKeyRow {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** API keys for the read-only external event feed (/api/ext/v1). The key value is shown once, on create. */
function ApiKeysSection() {
  const keys = useQuery({ queryKey: ['ext-keys'], queryFn: () => api.get<ApiKeyRow[]>('/api/integrations/keys') });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);

  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ key: string }>('/api/integrations/keys', { name: name.trim() });
      setNewKey(r.key);
      setName('');
      keys.refetch();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    try {
      await api.del(`/api/integrations/keys/${id}`);
      keys.refetch();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const live = keys.data?.filter((k) => !k.revokedAt) ?? [];
  return (
    <section className="card p-4">
      <h3 className="mb-2 font-semibold">External API keys</h3>
      <p className="mb-3 text-sm text-muted">
        Read-only access to the event feed (<code>/api/ext/v1</code>) for an outside system. The key is shown once — store it safely.
      </p>
      {newKey && (
        <div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
          <div className="mb-1 font-semibold text-amber-900 dark:text-amber-200">Copy this key now — it won't be shown again:</div>
          <code className="block break-all rounded bg-surface px-2 py-1 text-foreground">{newKey}</code>
          <button type="button" className="btn-ghost mt-2" onClick={() => setNewKey(null)}>
            Done
          </button>
        </div>
      )}
      <div className="mb-3 flex items-center gap-2">
        <input className={field} placeholder="Key name (e.g. n8n outreach feed)" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn-primary" disabled={busy || !name.trim()} onClick={create}>
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </div>
      {live.length === 0 ? (
        <p className="text-sm text-subtle">No keys yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {live.map((k) => (
            <li key={k.id} className="flex items-center gap-3 py-2 text-sm">
              <span className="flex-1 font-medium">{k.name}</span>
              <span className="text-subtle">
                {k.lastUsedAt ? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : 'never used'}
              </span>
              <button type="button" className="btn-danger" onClick={() => revoke(k.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
