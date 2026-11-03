// Light/dark theme: a `.dark` class on <html> drives the semantic tokens in index.css. The default follows the OS
// (prefers-color-scheme); the header toggle overrides it and remembers the choice in localStorage. The initial class
// is set before paint by the inline script in index.html, so this module only reads and flips it.
import { useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'theme';

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** The theme currently applied to the document (set pre-paint by index.html). */
export function getTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/** Apply and remember a theme. */
export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
  document.documentElement.classList.toggle('dark', t === 'dark');
}

/** Re-apply the saved theme, or the OS preference when the user hasn't chosen one. */
export function applyTheme(): void {
  const saved = localStorage.getItem(KEY) as Theme | null;
  document.documentElement.classList.toggle('dark', saved ? saved === 'dark' : prefersDark());
}

/** Current theme plus a toggle, for the header switch. */
export function useTheme(): [Theme, () => void] {
  const [theme, set] = useState<Theme>(getTheme);
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    set(next);
  };
  return [theme, toggle];
}
