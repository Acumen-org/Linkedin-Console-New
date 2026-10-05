// Browser test for self-healing. Needs a Chrome with remote debugging:
//   chrome --remote-debugging-port=9333 --user-data-dir=<tmp> --headless=new
//   HEAL_TEST_CDP=http://127.0.0.1:9333 node --test test/heal.browser.test.ts
// Skipped when HEAL_TEST_CDP is not set.

import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'patchright';
import { type AskModel, createHealer } from '../src/bridge/heal.ts';

const CDP = process.env.HEAL_TEST_CDP ?? '';

const fakeRedis = () => {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => {
      m.set(k, v);
    },
    del: async (k: string) => {
      m.delete(k);
    },
    map: m,
  };
};

// "New LinkedIn UI": the classes our selectors expect are gone.
const PAGE = `<!doctype html><html><body><main>
  <h1>Messaging</h1>
  <div contenteditable="true" role="textbox" aria-label="Type your reply" class="composer-v2"></div>
  <button aria-label="Attach">📎</button>
  <button class="send-v2">Send now</button>
</main></body></html>`;

test('heals a broken selector using the accessibility snapshot, then reuses the cache', { skip: !CDP }, async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  await page.setContent(PAGE);

  const redis = fakeRedis();
  let calls = 0;
  let sawSnapshot = '';
  // Stand-in for the model: answers from the snapshot like an LLM would.
  const ask: AskModel = async (intent, snapshot) => {
    calls++;
    sawSnapshot = snapshot;
    return intent.includes('Send')
      ? { found: true, role: 'button', name: 'Send now', index: 0 }
      : { found: true, role: 'textbox', name: 'Type your reply', index: 0 };
  };
  const healer = createHealer({ redis, ask, log: { info() {}, error() {} } });

  const brokenComposer = page.locator('div.msg-form__contenteditable');
  const box = await healer.find(page, 'composer', 'the message text box', brokenComposer, 500);
  await box.click();
  await page.keyboard.type('hello');
  assert.equal(await page.locator('.composer-v2').innerText(), 'hello');
  assert.match(sawSnapshot, /textbox "Type your reply"/);

  const send = await healer.find(page, 'send', 'the Send button', page.locator('button.msg-form__send-button'), 500);
  assert.equal(await send.innerText(), 'Send now');
  assert.equal(calls, 2);

  // Second time: learned fix from cache, no model call.
  await healer.find(page, 'send', 'the Send button', page.locator('button.msg-form__send-button'), 500);
  assert.equal(calls, 2);
  assert.ok(redis.map.has('li:heal:send'));

  // Working primary selector: no model, no cache needed.
  const ok = await healer.find(page, 'attach', 'attach', page.getByRole('button', { name: 'Attach' }), 500);
  assert.equal(await ok.getAttribute('aria-label'), 'Attach');
  assert.equal(calls, 2);

  await page.close();
  await browser.close();
});

test('fails clearly when healing is disabled', { skip: !CDP }, async () => {
  const browser = await chromium.connectOverCDP(CDP);
  const page = await browser.contexts()[0].newPage();
  await page.setContent(PAGE);
  const healer = createHealer({ redis: fakeRedis(), log: { info() {}, error() {} } });
  await assert.rejects(healer.find(page, 'composer', 'x', page.locator('.nope'), 300), /not found/);
  await page.close();
  await browser.close();
});
