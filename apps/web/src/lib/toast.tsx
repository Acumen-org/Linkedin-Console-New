import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';

type Kind = 'info' | 'success' | 'error';
type T = { id: number; text: string; kind: Kind };

let items: T[] = [];
const subs = new Set<() => void>();
const notify = () => {
  for (const s of subs) s();
};
let seq = 0;

export function toast(text: string, kind: Kind = 'info') {
  const id = ++seq;
  items = [...items, { id, text, kind }];
  notify();
  setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3500);
}
function dismiss(id: number) {
  items = items.filter((t) => t.id !== id);
  notify();
}

export function Toaster() {
  const list = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => {
        subs.delete(cb);
      };
    },
    () => items,
  );
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 rounded-lg px-4 py-3 shadow-lg text-sm max-w-sm text-white ${t.kind === 'error' ? 'bg-red-600' : t.kind === 'success' ? 'bg-emerald-600' : 'bg-slate-800'}`}
        >
          {t.kind === 'error' ? <AlertCircle size={18} /> : t.kind === 'success' ? <CheckCircle2 size={18} /> : <Info size={18} />}
          <span className="flex-1">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="opacity-70 hover:opacity-100">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
