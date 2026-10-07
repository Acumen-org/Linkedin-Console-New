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
  Insert: 45,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  CapsLock: 20,
  ContextMenu: 93,
};

// Windows virtual key code of the *physical* key (KeyboardEvent.code). Chrome reads windowsVirtualKeyCode as the
// key that was pressed, so punctuation must not reuse its ASCII value ('.' = 46 would be VK_DELETE).
const CODE_VK: Record<string, number> = {
  Space: 32,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  IntlBackslash: 226,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
  NumpadEnter: 13,
};
function codeToVk(code: string): number | undefined {
  if (code in CODE_VK) return CODE_VK[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].charCodeAt(0); // 65-90
  m = /^Digit([0-9])$/.exec(code);
  if (m) return 48 + Number(m[1]);
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return 96 + Number(m[1]);
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (m) return 111 + Number(m[1]); // F1 = 112
  return undefined;
}

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
      const mods = msg.mods ?? {};
      // AltGr arrives as Ctrl+Alt (Windows): it types a character (e.g. @ or € on non-US layouts), it is no shortcut.
      const altGr = !!(mods.ctrl && mods.alt);
      const shortcut = !!mods.meta || (!!mods.ctrl && !altGr);
      const printable = [...key].length === 1 && !shortcut; // one character, incl. accented letters and emoji
      const m = printable && altGr ? modifiers({ ...mods, ctrl: false, alt: false }) : modifiers(mods);
      const text = printable ? key : key === 'Enter' ? '\r' : undefined;
      const ascii = /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0; // letters/digits only
      const vk = SPECIAL[key] ?? codeToVk(String(msg.code ?? '')) ?? ascii;
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
