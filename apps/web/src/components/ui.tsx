import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { STATUS } from '../lib/format';
import type { AccountStatus } from '../types';

const COLORS = ['bg-sky-600', 'bg-success', 'bg-violet-600', 'bg-warning', 'bg-rose-600', 'bg-teal-600', 'bg-indigo-600', 'bg-orange-600'];
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
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-foreground">
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
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button onClick={onClose} className="text-subtle hover:text-foreground">
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
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-subtle">
      {icon}
      <div className="font-semibold text-foreground">{title}</div>
      {children && <div className="max-w-sm text-sm">{children}</div>}
    </div>
  );
}

export function PageHeader({ title, purpose, children }: { title: string; purpose?: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold">{title}</h1>
        {purpose && <p className="hint">{purpose}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
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
          className={`absolute z-30 rounded-lg border border-border bg-surface p-1 shadow-lg ${side === 'top' ? 'bottom-full mb-1' : 'mt-1'} ${align === 'right' ? 'right-0' : 'left-0'}`}
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

/* ---------------------------------------------------------------------------
   Spine design system — shared primitives. Status is always a tone, never a
   raw red/green class; on/off is always a Toggle. See index.css for the looks.
   --------------------------------------------------------------------------- */

/** A status tone. `neutral` is the quiet, un-coloured default. */
export type Tone = 'success' | 'warning' | 'danger' | 'gold' | 'neutral';

const TONE_SOFT: Record<Tone, string> = {
  success: 'bg-success-soft text-success-ink',
  warning: 'bg-warning-soft text-warning-ink',
  danger: 'bg-danger-soft text-danger-ink',
  gold: 'bg-gold-soft text-gold-ink',
  neutral: 'bg-surface-muted text-muted',
};
const TONE_SIGNAL: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  gold: 'bg-gold',
  neutral: 'bg-subtle',
};
const SPINE: Record<Tone, string> = {
  success: 'spine spine-success',
  warning: 'spine spine-warning',
  danger: 'spine spine-danger',
  gold: 'spine',
  neutral: 'spine',
};

/** The product wordmark: "Alpha Connext" with the x in gold. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={className}>
      Alpha Conne<span className="text-gold">x</span>t
    </span>
  );
}

/** A real on/off switch — gold thumb when on. Keyboard-operable (role="switch"). */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'border-switch-on bg-switch-on' : 'border-border-strong bg-surface-muted'}`}
    >
      <span
        className={`absolute h-3.5 w-3.5 rounded-full shadow-sm transition-all ${checked ? 'left-[18px] bg-gold' : 'left-0.5 bg-subtle'}`}
      />
    </button>
  );
}

/** Status pill. Tone sets the colour; it never sets its own red/green. */
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_SOFT[tone]}`}>
      {tone !== 'neutral' && <span className={`h-1.5 w-1.5 rounded-full ${TONE_SIGNAL[tone]}`} />}
      {children}
    </span>
  );
}

/** A small status lamp (dot). */
export function Lamp({ tone = 'neutral', title }: { tone?: Tone; title?: string }) {
  return <span title={title} className={`inline-block h-2.5 w-2.5 rounded-full ${TONE_SIGNAL[tone]}`} />;
}

/** One banner, carrying a tone — replaces the ad-hoc banner styles. Gold edge by default. */
export function Banner({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <div className={`${SPINE[tone]} rounded-lg px-4 py-2.5 text-sm ${TONE_SOFT[tone]} ${className}`}>{children}</div>;
}

/** A card section: title, an optional one-line purpose, an optional control on the right. */
export function Section({
  title,
  purpose,
  action,
  children,
}: {
  title: string;
  purpose?: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {purpose && <p className="hint">{purpose}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** A labelled setting row with a control (often a Toggle) on the right. */
export function SettingRow({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {hint && <div className="hint">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A labelled fact: value under a small label. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm font-medium text-foreground">{children}</span>
    </div>
  );
}

/** Segmented control for 2–5 exclusive choices. The chosen item carries aria-pressed. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
