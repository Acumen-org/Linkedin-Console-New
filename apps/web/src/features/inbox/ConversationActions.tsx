import { useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Bell, BellRing, Check, Plus, Tag } from 'lucide-react';
import { useState } from 'react';
import { LabelChip, Popover } from '../../components/ui';
import { api } from '../../lib/api';
import { useLabels } from '../../lib/queries';
import { toast } from '../../lib/toast';
import type { Conversation, Label } from '../../types';

const LABEL_COLORS = ['#0a66c2', '#057642', '#b24020', '#915907', '#7c3aed', '#db2777', '#0891b2', '#64748b'];

export function LabelPicker({
  conversation,
  onChange,
  disabled,
}: {
  conversation: Conversation;
  onChange: (c: Conversation) => void;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const labels = useLabels();
  const [newName, setNewName] = useState('');
  // While a change is saving, further clicks wait (each save sends the whole set: two at once would undo one).
  const [saving, setSaving] = useState(false);
  const selected = new Set(conversation.labels.map((l) => l.id));

  const save = async (ids: string[]) => {
    setSaving(true);
    try {
      onChange(await api.put<Conversation>(`/api/conversations/${conversation.id}/labels`, { labelIds: ids }));
      qc.invalidateQueries({ queryKey: ['labels'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const toggle = (id: string) => save(selected.has(id) ? [...selected].filter((x) => x !== id) : [...selected, id]);
  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const color = LABEL_COLORS[(labels.data?.length ?? 0) % LABEL_COLORS.length];
      const label = await api.post<Label>('/api/labels', { name, color });
      setNewName('');
      await qc.invalidateQueries({ queryKey: ['labels'] });
      await save([...selected, label.id]);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <Popover
      trigger={({ toggle: open }) => (
        <button onClick={open} disabled={disabled} className="btn-ghost px-2" title="Labels">
          <Tag size={18} />
        </button>
      )}
    >
      {() => (
        <div className="space-y-1">
          <div className="px-2 pt-1 text-xs font-semibold text-slate-500">Labels</div>
          <div className="max-h-60 overflow-y-auto">
            {labels.data?.map((l) => (
              <button
                key={l.id}
                onClick={() => toggle(l.id)}
                disabled={saving}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100 disabled:opacity-60"
              >
                <span className="flex h-4 w-4 items-center justify-center rounded border border-slate-300">
                  {selected.has(l.id) && <Check size={12} />}
                </span>
                <LabelChip name={l.name} color={l.color} />
              </button>
            ))}
            {labels.data?.length === 0 && <div className="px-2 py-1 text-xs text-slate-500">No labels yet.</div>}
          </div>
          <div className="flex gap-1 border-t border-slate-100 p-1">
            <input
              className="input py-1 text-xs"
              placeholder="New label"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !saving && create()}
            />
            <button onClick={create} disabled={saving} className="btn-ghost px-2" title="Create label">
              <Plus size={14} />
            </button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function at(hoursFromNow: number) {
  return new Date(Date.now() + hoursFromNow * 3600_000);
}
function nextMorning(daysAhead: number) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(9, 0, 0, 0);
  return d;
}
function nextMonday() {
  const d = new Date();
  d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
  d.setHours(9, 0, 0, 0);
  return d;
}

export function SnoozeMenu({
  conversation,
  onChange,
  disabled,
}: {
  conversation: Conversation;
  onChange: (c: Conversation) => void;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState('');
  const snoozed = conversation.snoozedUntil && new Date(conversation.snoozedUntil) > new Date();

  const snooze = async (until: Date | null) => {
    try {
      onChange(
        await api.patch<Conversation>(`/api/conversations/${conversation.id}`, { snoozedUntil: until ? until.toISOString() : null }),
      );
      toast(
        until ? `Snoozed until ${until.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Unsnoozed',
        'success',
      );
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const options: [string, () => Date][] = [
    ['In 3 hours', () => at(3)],
    ['Tomorrow 9:00', () => nextMorning(1)],
    ['Next Monday 9:00', nextMonday],
    ['In 1 week', () => at(24 * 7)],
  ];

  return (
    <Popover
      trigger={({ toggle }) => (
        <button onClick={toggle} disabled={disabled} className={`btn-ghost px-2 ${snoozed ? 'text-amber-600' : ''}`} title="Snooze">
          <AlarmClock size={18} />
        </button>
      )}
      width={220}
    >
      {(close) => (
        <div>
          <div className="px-2 pt-1 pb-1 text-xs font-semibold text-slate-500">
            {snoozed ? `Snoozed until ${new Date(conversation.snoozedUntil!).toLocaleString()}` : 'Snooze until…'}
          </div>
          {options.map(([label, fn]) => (
            <button
              key={label}
              onClick={() => {
                snooze(fn());
                close();
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100"
            >
              {label}
            </button>
          ))}
          <div className="flex gap-1 border-t border-slate-100 p-1">
            <input type="datetime-local" className="input py-1 text-xs" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button
              disabled={!custom}
              onClick={() => {
                snooze(new Date(custom));
                close();
              }}
              className="btn-ghost px-2 text-xs"
            >
              Set
            </button>
          </div>
          {snoozed && (
            <button
              onClick={() => {
                snooze(null);
                close();
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-sm text-brand hover:bg-slate-100"
            >
              Unsnooze now
            </button>
          )}
          <div className="px-2 pb-1 text-[11px] text-slate-500">It comes back earlier if they reply.</div>
        </div>
      )}
    </Popover>
  );
}

const dueLabel = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** True when the reminder's time has passed. */
export const isOverdue = (iso: string) => new Date(iso).getTime() <= Date.now();

/**
 * The prospect's follow-up reminder: set a time (and a note), move it, or close it as Done (followed up) or
 * Closed (stop following this prospect). It reaches whoever the conversation is for, and Twenty when connected.
 */
export function ReminderMenu({
  conversation,
  onChange,
  disabled,
}: {
  conversation: Conversation;
  onChange: (c: Conversation) => void;
  disabled?: boolean;
}) {
  const r = conversation.reminder;
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState(r?.note ?? '');

  const set = async (dueAt: Date) => {
    try {
      onChange(await api.put<Conversation>(`/api/conversations/${conversation.id}/reminder`, { dueAt: dueAt.toISOString(), note }));
      toast(`Reminder set for ${dueLabel(dueAt.toISOString())}`, 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const close = async (status: 'DONE' | 'CLOSED') => {
    try {
      onChange(await api.post<Conversation>(`/api/conversations/${conversation.id}/reminder/close`, { status }));
      toast(status === 'DONE' ? 'Follow-up done' : 'Prospect closed: no more reminders', 'success');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const options: [string, () => Date][] = [
    ['Tomorrow 9:00', () => nextMorning(1)],
    ['In 3 days, 9:00', () => nextMorning(3)],
    ['Next Monday 9:00', nextMonday],
    ['In 2 weeks', () => nextMorning(14)],
  ];
  const tone = r ? (isOverdue(r.dueAt) ? 'text-red-600' : 'text-brand') : '';

  return (
    <Popover
      trigger={({ toggle }) => (
        <button
          onClick={() => {
            setNote(conversation.reminder?.note ?? '');
            toggle();
          }}
          disabled={disabled}
          className={`btn-ghost px-2 ${tone}`}
          title={r ? `Follow up ${dueLabel(r.dueAt)}` : 'Remind me to follow up'}
        >
          {r ? <BellRing size={18} /> : <Bell size={18} />}
        </button>
      )}
      width={260}
    >
      {(closeMenu) => (
        <div>
          <div className="px-2 pt-1 pb-1 text-xs font-semibold text-slate-500">
            {r ? (
              <span className={tone}>
                Follow up {dueLabel(r.dueAt)}
                {r.responsibleName ? ` · for ${r.responsibleName}` : ' · for the team'}
              </span>
            ) : (
              'Remind to follow up…'
            )}
          </div>
          <div className="px-1 pb-1">
            <input
              className="input py-1 text-xs"
              placeholder="Note (optional), e.g. send the pricing"
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {options.map(([label, fn]) => (
            <button
              key={label}
              onClick={() => {
                set(fn());
                closeMenu();
              }}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100"
            >
              {label}
            </button>
          ))}
          <div className="flex gap-1 border-t border-slate-100 p-1">
            <input type="datetime-local" className="input py-1 text-xs" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button
              disabled={!custom}
              onClick={() => {
                set(new Date(custom));
                closeMenu();
              }}
              className="btn-ghost px-2 text-xs"
            >
              Set
            </button>
          </div>
          {r && (
            <div className="flex gap-1 border-t border-slate-100 p-1">
              <button
                onClick={() => {
                  close('DONE');
                  closeMenu();
                }}
                className="btn-outline flex-1 px-2 py-1 text-xs"
                title="I followed up"
              >
                <Check size={13} /> Done
              </button>
              <button
                onClick={() => {
                  close('CLOSED');
                  closeMenu();
                }}
                className="btn-ghost flex-1 px-2 py-1 text-xs"
                title="Stop following up this prospect"
              >
                Close prospect
              </button>
            </div>
          )}
        </div>
      )}
    </Popover>
  );
}
