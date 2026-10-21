import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, Copy, Pencil, Plus, Send, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useParams } from 'react-router';
import { isAdmin, useMe } from '../../App';
import { PageScroll } from '../../components/Layout';
import { Empty, LabelChip, Modal, PageHeader } from '../../components/ui';
import { api } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../../lib/push';
import { useAppConfig, useLabels, useTemplates } from '../../lib/queries';
import { toast } from '../../lib/toast';
import type { Template, Webhook, WebhookEvent } from '../../types';
import { CrmBindingsTab } from './CrmBindingsTab';
import { IntegrationsTab } from './IntegrationsTab';

const TABS = [
  { id: 'templates', label: 'Saved replies' },
  { id: 'labels', label: 'Labels' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'webhooks', label: 'Webhooks', admin: true },
  { id: 'integrations', label: 'Twenty CRM', admin: true },
  { id: 'bindings', label: 'CRM bindings', crm: true },
];

export function SettingsPage() {
  const me = useMe();
  const config = useAppConfig();
  const { tab = 'templates' } = useParams();
  return (
    <PageScroll>
      <PageHeader title="Settings" />
      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {TABS.filter((t) => (!t.admin || isAdmin(me)) && (!t.crm || !!config.data?.twentyUrl)).map((t) => (
          <NavLink
            key={t.id}
            to={`/settings/${t.id}`}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-4 py-2 text-sm font-semibold ${isActive || (tab === t.id) ? 'border-brand text-brand' : 'border-transparent text-slate-500 hover:text-slate-800'}`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </div>
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'labels' && <LabelsTab />}
      {tab === 'notifications' && <NotificationsTab />}
      {tab === 'webhooks' && isAdmin(me) && <WebhooksTab />}
      {tab === 'integrations' && isAdmin(me) && <IntegrationsTab />}
      {tab === 'bindings' && <CrmBindingsTab />}
    </PageScroll>
  );
}

// ---------- saved replies ----------
function TemplatesTab() {
  const me = useMe();
  const templates = useTemplates();
  const [editing, setEditing] = useState<Partial<Template> | null>(null);
  const remove = async (t: Template) => {
    if (!confirm(`Delete "${t.title}"?`)) return;
    await api.del(`/api/templates/${t.id}`).catch((e) => toast(e.message, 'error'));
    templates.refetch();
  };
  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-slate-600">
          Use in the composer with the <b>💬</b> button. Variables: <code>{'{firstName}'}</code> <code>{'{name}'}</code>{' '}
          <code>{'{myFirstName}'}</code> <code>{'{myName}'}</code> <code>{'{account}'}</code>
        </p>
        <button onClick={() => setEditing({ shared: true })} className="btn-primary">
          <Plus size={16} /> New
        </button>
      </div>
      <div className="card divide-y divide-slate-100">
        {templates.data?.length === 0 && <Empty title="No saved replies yet" />}
        {templates.data?.map((t) => (
          <div key={t.id} className="flex items-start gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                {t.title} {!t.shared && <span className="text-xs font-normal text-slate-500">(private)</span>}
              </div>
              <div className="line-clamp-2 whitespace-pre-wrap text-sm text-slate-600">{t.body}</div>
              <div className="text-xs text-slate-400">by {t.userName}</div>
            </div>
            {(t.userId === me.id || isAdmin(me)) && (
              <>
                <button onClick={() => setEditing(t)} className="btn-ghost px-2" title="Edit">
                  <Pencil size={16} />
                </button>
                <button onClick={() => remove(t)} className="btn-ghost px-2 text-red-600" title="Delete">
                  <Trash2 size={16} />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      {editing && (
        <TemplateModal
          template={editing}
          onClose={() => {
            setEditing(null);
            templates.refetch();
          }}
        />
      )}
    </>
  );
}

function TemplateModal({ template, onClose }: { template: Partial<Template>; onClose: () => void }) {
  const [form, setForm] = useState({ title: template.title ?? '', body: template.body ?? '', shared: template.shared ?? true });
  const save = async () => {
    try {
      if (template.id) await api.put(`/api/templates/${template.id}`, form);
      else await api.post('/api/templates', form);
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal title={template.id ? 'Edit saved reply' : 'New saved reply'} onClose={onClose} wide>
      <div className="space-y-3">
        <div>
          <label className="label">Title</label>
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div>
          <label className="label">Message</label>
          <textarea
            className="input min-h-40"
            value={form.body}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
            placeholder="Hi {firstName}, thanks for connecting!"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.shared} onChange={(e) => setForm({ ...form, shared: e.target.checked })} /> Share with the
          whole team
        </label>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            Cancel
          </button>
          <button onClick={save} disabled={!form.title.trim() || !form.body.trim()} className="btn-primary">
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- labels ----------
function LabelsTab() {
  const me = useMe();
  const qc = useQueryClient();
  const labels = useLabels();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#0a66c2');
  const refresh = () => qc.invalidateQueries({ queryKey: ['labels'] });
  const create = async () => {
    try {
      await api.post('/api/labels', { name, color });
      setName('');
      refresh();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const remove = async (id: string, labelName: string) => {
    if (!confirm(`Delete label "${labelName}"? It will be removed from all conversations.`)) return;
    await api.del(`/api/labels/${id}`).catch((e) => toast(e.message, 'error'));
    refresh();
  };
  return (
    <>
      <div className="card mb-4 flex flex-wrap items-end gap-2 p-4">
        <div className="flex-1">
          <label className="label">New label</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Hot lead" />
        </div>
        <div>
          <label className="label">Color</label>
          <input
            type="color"
            className="h-9 w-14 rounded border border-slate-300"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        <button onClick={create} disabled={!name.trim()} className="btn-primary">
          <Plus size={16} /> Add
        </button>
      </div>
      <div className="card divide-y divide-slate-100">
        {labels.data?.length === 0 && <Empty title="No labels yet" />}
        {labels.data?.map((l) => (
          <div key={l.id} className="flex items-center gap-3 px-4 py-2.5">
            <LabelChip name={l.name} color={l.color} />
            <span className="flex-1 text-xs text-slate-500">
              {l.usage} conversation{l.usage === 1 ? '' : 's'}
            </span>
            {isAdmin(me) && (
              <button onClick={() => remove(l.id, l.name)} className="btn-ghost px-2 text-red-600">
                <Trash2 size={16} />
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

// ---------- notifications ----------
function NotificationsTab() {
  const config = useAppConfig();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    currentSubscription()
      .then((s) => setEnabled(!!s))
      .catch(() => setEnabled(false));
  }, []);

  if (!pushSupported()) {
    return (
      <div className="card p-5 text-sm text-slate-600">
        This browser can't receive push notifications here. They need HTTPS (your real domain) and a modern browser.
      </div>
    );
  }
  const toggle = async () => {
    setBusy(true);
    try {
      if (enabled) await disablePush();
      else await enablePush(config.data!.vapidPublicKey!);
      setEnabled(!enabled);
      toast(enabled ? 'Notifications turned off on this device' : 'Notifications turned on for this device', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card max-w-xl space-y-3 p-5">
      <div className="flex items-center gap-3">
        {enabled ? <Bell className="text-brand" /> : <BellOff className="text-slate-400" />}
        <div className="flex-1">
          <div className="font-semibold">Push notifications on this device</div>
          <div className="text-sm text-slate-600">
            Get a notification for every new LinkedIn message in accounts you can access, even when the app is closed.
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={busy || enabled === null || !config.data?.vapidPublicKey}
          className={enabled ? 'btn-outline' : 'btn-primary'}
        >
          {enabled ? 'Turn off' : 'Turn on'}
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Tip: install the app (browser menu → "Install app" / "Add to Home Screen") for a phone-app experience.
      </p>
    </div>
  );
}

// ---------- webhooks (admin) ----------
const EVENT_LABELS: Record<WebhookEvent, string> = {
  'message.received': 'New message received',
  'message.sent': 'Message sent by the team',
  'conversation.assigned': 'Conversation assigned',
  'account.status': 'Account status changed',
};

function WebhooksTab() {
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<Webhook[]>('/api/webhooks') });
  const [editing, setEditing] = useState<Partial<Webhook> | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const test = async (h: Webhook) => {
    const r = await api
      .post<{ ok: boolean; status: number | null; error: string | null }>(`/api/webhooks/${h.id}/test`)
      .catch((e) => ({ ok: false, status: null, error: e.message }));
    toast(r.ok ? `Delivered (HTTP ${r.status})` : `Failed: ${r.error}`, r.ok ? 'success' : 'error');
    hooks.refetch();
  };
  const remove = async (h: Webhook) => {
    if (!confirm(`Delete webhook to ${h.url}?`)) return;
    await api.del(`/api/webhooks/${h.id}`);
    hooks.refetch();
  };
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-4">
        <p className="text-sm text-slate-600">
          Send events to your CRM, Slack, Zapier or n8n. Each request is a JSON POST signed with{' '}
          <code>X-LinkedIn-Console-Signature: sha256=…</code> (HMAC of the body with the webhook secret).
        </p>
        <button onClick={() => setEditing({ events: ['message.received'], active: true })} className="btn-primary shrink-0">
          <Plus size={16} /> Add
        </button>
      </div>
      <div className="card divide-y divide-slate-100">
        {hooks.data?.length === 0 && <Empty icon={<WebhookIcon size={28} />} title="No webhooks yet" />}
        {hooks.data?.map((h) => (
          <div key={h.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-sm">{h.url}</div>
              <div className="text-xs text-slate-500">
                {h.events.map((e) => EVENT_LABELS[e]).join(' · ')} {!h.active && '· paused'}
              </div>
              {h.lastDeliveryAt && (
                <div className={`text-xs ${h.lastError ? 'text-red-600' : 'text-emerald-700'}`}>
                  Last delivery {timeAgo(h.lastDeliveryAt)}: {h.lastError ?? `HTTP ${h.lastStatus}`}
                </div>
              )}
            </div>
            <button onClick={() => test(h)} className="btn-ghost text-xs">
              <Send size={14} /> Test
            </button>
            <button onClick={() => setEditing(h)} className="btn-ghost px-2">
              <Pencil size={16} />
            </button>
            <button onClick={() => remove(h)} className="btn-ghost px-2 text-red-600">
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </div>
      {editing && (
        <WebhookModal
          hook={editing}
          onClose={(newSecret) => {
            setEditing(null);
            if (newSecret) setSecret(newSecret);
            hooks.refetch();
          }}
        />
      )}
      {secret && (
        <Modal title="Webhook secret" onClose={() => setSecret(null)}>
          <p className="text-sm">Use this secret to verify signatures. It is shown only once.</p>
          <div className="mt-3 flex gap-2">
            <code className="flex-1 break-all rounded bg-slate-100 p-2 text-xs">{secret}</code>
            <button onClick={() => navigator.clipboard.writeText(secret).then(() => toast('Copied', 'success'))} className="btn-ghost px-2">
              <Copy size={16} />
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function WebhookModal({ hook, onClose }: { hook: Partial<Webhook>; onClose: (secret?: string) => void }) {
  const [url, setUrl] = useState(hook.url ?? '');
  const [events, setEvents] = useState<WebhookEvent[]>(hook.events ?? []);
  const [active, setActive] = useState(hook.active ?? true);
  const save = async () => {
    try {
      if (hook.id) {
        await api.put(`/api/webhooks/${hook.id}`, { url, events, active });
        onClose();
      } else {
        const created = await api.post<Webhook & { secret: string }>('/api/webhooks', { url, events, active });
        onClose(created.secret);
      }
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal title={hook.id ? 'Edit webhook' : 'Add webhook'} onClose={() => onClose()}>
      <div className="space-y-3">
        <div>
          <label className="label">URL</label>
          <input
            className="input font-mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks.example.com/linkedin-console"
          />
        </div>
        <div>
          <label className="label">Events</label>
          {(Object.keys(EVENT_LABELS) as WebhookEvent[]).map((ev) => (
            <label key={ev} className="flex items-center gap-2 py-0.5 text-sm">
              <input
                type="checkbox"
                checked={events.includes(ev)}
                onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))}
              />
              {EVENT_LABELS[ev]} <code className="text-xs text-slate-400">{ev}</code>
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
        </label>
        <div className="flex justify-end gap-2">
          <button onClick={() => onClose()} className="btn-ghost">
            Cancel
          </button>
          <button onClick={save} disabled={!url || !events.length} className="btn-primary">
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
