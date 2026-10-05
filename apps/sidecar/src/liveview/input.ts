// Maps viewer input (relative coordinates, DOM key events) to CDP Input/Page commands.
import type { Cdp } from '../cdp.ts';

export interface ScreenMeta {
  deviceWidth: number;
  deviceHeight: number;
}

type Mods = { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean };

export type InputMessage =
  | { t: 'mouse'; type: string; x: number; y: number; button?: string; buttons?: number; clickCount?: number; mods?: Mods }
  | { t: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { t: 'key'; key: string; code: string; mods?: Mods }
  | { t: 'paste'; text: string }
  | { t: 'navigate'; url: string }
  | { t: 'back' }
  | { t: 'reload' }
  | { t: 'file'; name: string; data: string };

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
const SPECIAL: Record<string, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

const modifiers = (m: Mods = {}) => (Object.entries(MOD) as [keyof Mods, number][]).reduce((acc, [k, v]) => acc | (m[k] ? v : 0), 0);

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

export async function dispatchInput(cdp: Cdp, msg: InputMessage, meta: ScreenMeta) {
  const xy = (m: { x: number; y: number }) => ({ x: clamp01(m.x) * meta.deviceWidth, y: clamp01(m.y) * meta.deviceHeight });

  switch (msg.t) {
    case 'mouse':
      return cdp.send('Input.dispatchMouseEvent', {
        type: msg.type,
        ...xy(msg),
        button: msg.button ?? 'none',
        buttons: msg.buttons ?? 0,
        clickCount: msg.clickCount ?? 0,
        modifiers: modifiers(msg.mods),
      });
    case 'wheel':
      return cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...xy(msg),
        deltaX: Number(msg.dx) || 0,
        deltaY: Number(msg.dy) || 0,
      });
    case 'key': {
      const key = String(msg.key);
      const m = modifiers(msg.mods);
      const printable = key.length === 1 && !(m & (MOD.ctrl | MOD.meta));
      const text = printable ? key : key === 'Enter' ? '\r' : undefined;
      const vk = SPECIAL[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      await cdp.send('Input.dispatchKeyEvent', {
        type: text ? 'keyDown' : 'rawKeyDown',
        key,
        code: msg.code,
        windowsVirtualKeyCode: vk,
        modifiers: m,
        ...(text ? { text } : {}),
      });
      return cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: msg.code, windowsVirtualKeyCode: vk, modifiers: m });
    }
    case 'paste':
      return cdp.send('Input.insertText', { text: String(msg.text).slice(0, 20_000) });
    case 'navigate': {
      let url = String(msg.url).trim();
      if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
      return cdp.send('Page.navigate', { url });
    }
    case 'back': {
      const h = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
      if (h.currentIndex > 0) return cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
      return;
    }
    case 'reload':
      return cdp.send('Page.reload');
  }
}
