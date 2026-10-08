// Keyboard input from the live viewer -> CDP Input.dispatchKeyEvent.
// Chrome treats windowsVirtualKeyCode as the physical key, so punctuation must not reuse its ASCII
// value (e.g. '.' = 46 = VK_DELETE). Each test types one key and checks what Chrome is told.

import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchInput } from '../src/liveview/input.ts';

type Sent = { method: string; params: Record<string, any> };
const meta = { deviceWidth: 1440, deviceHeight: 900 };

async function press(key: string, code: string, mods: Record<string, boolean> = {}) {
  const sent: Sent[] = [];
  const cdp = { send: async (method: string, params: Record<string, any> = {}) => void sent.push({ method, params }) };
  await dispatchInput(cdp as any, { t: 'key', key, code, mods }, meta);
  const down = sent.find((s) => s.params.type === 'keyDown' || s.params.type === 'rawKeyDown');
  const up = sent.find((s) => s.params.type === 'keyUp');
  assert.ok(down && up, `expected keyDown + keyUp for ${key}`);
  return { down: down.params, up: up.params };
}

test('punctuation types its character and uses the punctuation key code, not an arrow/Delete code', async () => {
  const cases: [string, string, number][] = [
    ['.', 'Period', 190],
    ['-', 'Minus', 189],
    ["'", 'Quote', 222],
    ['/', 'Slash', 191],
    [',', 'Comma', 188],
    [';', 'Semicolon', 186],
    ['=', 'Equal', 187],
    ['[', 'BracketLeft', 219],
    [']', 'BracketRight', 221],
    ['\\', 'Backslash', 220],
    ['`', 'Backquote', 192],
  ];
  for (const [key, code, vk] of cases) {
    const { down, up } = await press(key, code);
    assert.equal(down.type, 'keyDown', key);
    assert.equal(down.text, key, key);
    assert.equal(down.windowsVirtualKeyCode, vk, key);
    assert.equal(up.windowsVirtualKeyCode, vk, key);
  }
});

test('shifted symbols type their character with the key code of the physical key', async () => {
  const cases: [string, string, number][] = [
    ['@', 'Digit2', 50],
    ['!', 'Digit1', 49],
    ['#', 'Digit3', 51],
    ['$', 'Digit4', 52],
    ['%', 'Digit5', 53],
    ['(', 'Digit9', 57],
    [')', 'Digit0', 48],
    ['_', 'Minus', 189],
    ['"', 'Quote', 222],
    ['?', 'Slash', 191],
  ];
  for (const [key, code, vk] of cases) {
    const { down } = await press(key, code, { shift: true });
    assert.equal(down.text, key, key);
    assert.equal(down.windowsVirtualKeyCode, vk, key);
    assert.equal(down.modifiers, 8, key); // shift
  }
});

test('letters, digits and space still work', async () => {
  for (const [key, code, vk] of [
    ['a', 'KeyA', 65],
    ['Z', 'KeyZ', 90],
    ['7', 'Digit7', 55],
    [' ', 'Space', 32],
  ] as const) {
    const { down } = await press(key, code, key === 'Z' ? { shift: true } : {});
    assert.equal(down.text, key);
    assert.equal(down.windowsVirtualKeyCode, vk);
  }
});

test('AltGr (Ctrl+Alt) characters on non-US keyboards are typed, not treated as shortcuts', async () => {
  for (const [key, code] of [
    ['@', 'KeyQ'],
    ['€', 'KeyE'],
    ['{', 'Digit7'],
  ] as const) {
    const { down } = await press(key, code, { ctrl: true, alt: true });
    assert.equal(down.type, 'keyDown', key);
    assert.equal(down.text, key, key);
    assert.equal(down.modifiers, 0, `${key}: AltGr must not reach the page as Ctrl+Alt`);
  }
});

test('accented letters and emoji are typed as text', async () => {
  for (const [key, code] of [
    ['é', 'KeyE'],
    ['ñ', 'Semicolon'],
    ['😀', ''],
  ] as const) {
    const { down } = await press(key, code);
    assert.equal(down.type, 'keyDown', key);
    assert.equal(down.text, key, key);
  }
});

test('shortcuts stay shortcuts: Ctrl/Cmd + letter send no text', async () => {
  for (const mods of [{ ctrl: true }, { meta: true }] as Record<string, boolean>[]) {
    const { down } = await press('a', 'KeyA', mods);
    assert.equal(down.type, 'rawKeyDown');
    assert.equal(down.text, undefined);
    assert.equal(down.windowsVirtualKeyCode, 65);
  }
});

test('special and function keys are mapped', async () => {
  const cases: [string, string, number][] = [
    ['Enter', 'Enter', 13],
    ['Backspace', 'Backspace', 8],
    ['Tab', 'Tab', 9],
    ['Escape', 'Escape', 27],
    ['Delete', 'Delete', 46],
    ['Insert', 'Insert', 45],
    ['ArrowLeft', 'ArrowLeft', 37],
    ['Home', 'Home', 36],
    ['F1', 'F1', 112],
    ['F5', 'F5', 116],
    ['F12', 'F12', 123],
    ['CapsLock', 'CapsLock', 20],
  ];
  for (const [key, code, vk] of cases) {
    const { down } = await press(key, code);
    assert.equal(down.windowsVirtualKeyCode, vk, key);
  }
  const enter = await press('Enter', 'Enter');
  assert.equal(enter.down.text, '\r');
  const backspace = await press('Backspace', 'Backspace');
  assert.equal(backspace.down.text, undefined);
});

test('numeric keypad keys type their character with keypad key codes', async () => {
  const cases: [string, string, number][] = [
    ['5', 'Numpad5', 101],
    ['.', 'NumpadDecimal', 110],
    ['+', 'NumpadAdd', 107],
  ];
  for (const [key, code, vk] of cases) {
    const { down } = await press(key, code);
    assert.equal(down.text, key);
    assert.equal(down.windowsVirtualKeyCode, vk);
  }
  const enter = await press('Enter', 'NumpadEnter');
  assert.equal(enter.down.windowsVirtualKeyCode, 13);
});
