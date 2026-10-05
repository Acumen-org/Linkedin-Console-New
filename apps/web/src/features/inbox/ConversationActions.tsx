import { useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Check, Plus, Tag } from 'lucide-react';
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
  const selected = new Set(conversation.labels.map((l) => l.id));

  const save = async (ids: string[]) => {
    try {
      onChange(await api.put<Conversation>(`/api/conversations/${conversation.id}/labels`, { labelIds: ids }));
      qc.invalidateQueries({ queryKey: ['labels'] });
    } catch (e) {
      toast((e as Error).message, 'error');
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
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-slate-100"
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
              onKeyDown={(e) => e.key === 'Enter' && create()}
            />
            <button onClick={create} className="btn-ghost px-2" title="Create label">
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
