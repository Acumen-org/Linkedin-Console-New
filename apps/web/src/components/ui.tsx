import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { STATUS } from '../lib/format';
import type { AccountStatus } from '../types';

const COLORS = [
  'bg-sky-600',
  'bg-emerald-600',
  'bg-violet-600',
  'bg-amber-600',
  'bg-rose-600',
  'bg-teal-600',
  'bg-indigo-600',
  'bg-orange-600',
];
const colorFor = (s: string) => COLORS[[...s].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';

export function Avatar({ name, src, size = 40, ring }: { name: string; src?: string | null; size?: number; ring?: string }) {
  const style = { width: size, height: size, fontSize: size * 0.38 };
  const cls = `shrink-0 rounded-full object-cover ${ring ? `ring-2 ${ring}` : ''}`;
  if (src) return <img src={src} alt={name} style={style} className={cls} referrerPolicy="no-referrer" loading="lazy" />;
  return (
    <div style={style} className={`${cls} ${colorFor(name)} flex items-center justify-center font-semibold text-white`}>
      {initials(name)}
    </div>
  );
}

export function StatusDot({ status }: { status: AccountStatus }) {
  return (
    <span title={STATUS[status]?.label} className={`inline-block h-2.5 w-2.5 rounded-full ${STATUS[status]?.color ?? 'bg-slate-400'}`} />
  );
}

export function StatusBadge({ status }: { status: AccountStatus }) {
  const s = STATUS[status] ?? { label: status, color: 'bg-slate-400' };
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-700">
      <span className={`h-2 w-2 rounded-full ${s.color}`} /> {s.label}
    </span>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`card w-full ${wide ? 'max-w-2xl' : 'max-w-md'} shadow-xl`}>
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800">
            <X size={18} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-slate-500">
      {icon}
      <div className="font-semibold text-slate-700">{title}</div>
      {children && <div className="max-w-sm text-sm">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

/** Small dropdown anchored to a trigger; closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = 'right',
  side = 'bottom',
  width = 260,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  /** Open below (default) or above the trigger, e.g. for the composer at the bottom of the screen. */
  side?: 'top' | 'bottom';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          style={{ width }}
          className={`absolute z-30 rounded-lg border border-slate-200 bg-white p-1 shadow-lg ${side === 'top' ? 'bottom-full mb-1' : 'mt-1'} ${align === 'right' ? 'right-0' : 'left-0'}`}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function LabelChip({ name, color, small }: { name: string; color: string; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-medium ${small ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-xs'}`}
      style={{ backgroundColor: `${color}22`, color }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {name}
    </span>
  );
}
