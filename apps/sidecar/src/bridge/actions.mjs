// UI actions performed in the bridge's own window, at human pace.
// Selectors are role/label-first with LinkedIn class fallbacks. If LinkedIn changes
// its UI, this is the file to update (see docs/BRIDGE_MAINTENANCE.md).

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min, max) => sleep(min + Math.random() * (max - min));
const rand = (min, max) => Math.round(min + Math.random() * (max - min));

export const IDLE_URL = 'https://www.linkedin.com/messaging/thread/new/';

// Self-healing lookup (see heal.mjs); falls back to the plain locator when not set.
let healer = null;
export const setHealer = (h) => { healer = h; };
async function find(page, key, intent, primary, timeout = 20_000) {
  if (healer) return healer.find(page, key, intent, primary, timeout);
  await primary.waitFor({ state: 'visible', timeout });
  return primary;
}

function composer(page) {
  return page.locator('div.msg-form__contenteditable[contenteditable="true"]')
    .or(page.getByRole('textbox', { name: /write a message/i }))
    .last();
}

function sendButton(page) {
  return page.locator('button.msg-form__send-button, button.msg-form__send-btn')
    .or(page.getByRole('button', { name: /^send$/i }))
    .last();
}

async function waitEnabled(locator, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) return true;
    await sleep(400);
  }
  return false;
}

async function attachFiles(page, files) {
  for (const f of files) {
    const isImage = /^image\//.test(f.mime ?? '');
    const scoped = page.locator('.msg-form input[type="file"], .msg-overlay-conversation-bubble input[type="file"]');
    const imageInput = scoped.and(page.locator('[accept*="image"]')).last();
    const fileInput = scoped.and(page.locator(':not([accept*="image"])')).last();
    const anyInput = page.locator('input[type="file"]').last();
    const target = isImage && await imageInput.count() ? imageInput : await fileInput.count() ? fileInput : anyInput;
    await target.setInputFiles(f.path);
    await jitter(2000, 3500);
  }
}

async function typeMessage(page, box, text) {
  await box.click();
  await jitter(400, 900);
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Type the start naturally, paste the rest of long lines (keeps long messages fast).
    const head = line.slice(0, 60);
    const tail = line.slice(60);
    if (head) await page.keyboard.type(head, { delay: rand(25, 70) });
    if (tail) await page.keyboard.insertText(tail);
    if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
  }
}

async function composeAndSend(page, text, files) {
  const box = await find(page, 'composer', 'the text box of the message composer where you type a reply', composer(page), 25_000);
  await jitter(800, 2000);
  if (files?.length) await attachFiles(page, files);
  if (text) await typeMessage(page, box, text);
  await jitter(600, 1500);
  const btn = await find(page, 'send', 'the Send button of the message composer', sendButton(page), 10_000);
  if (!(await waitEnabled(btn, 60_000))) throw new Error('Send button never became enabled (upload stuck or UI changed)');
  await btn.click();
}

export async function sendInThread(page, { threadId, text, files }) {
  await page.goto(`https://www.linkedin.com/messaging/thread/${threadId}/`, { waitUntil: 'domcontentloaded' });
  await composeAndSend(page, text, files);
}

export async function startChat(page, { profileUrl, text, files }) {
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await jitter(2000, 4000);
  const primary = page.locator('main').getByRole('button', { name: /^message\b/i })
    .or(page.locator('main').getByRole('link', { name: /^message\b/i })).first();
  const btn = await find(page, 'profile-message', "the 'Message' button in the profile's top card that opens a chat with this person", primary);
  await btn.click();
  await jitter(1500, 3000);
  await composeAndSend(page, text, files);
}

export async function openThread(page, threadId) {
  await page.goto(`https://www.linkedin.com/messaging/thread/${threadId}/`, { waitUntil: 'domcontentloaded' });
  await jitter(3000, 5000);
}

/** Load the conversation list (without opening any thread) and scroll it to load more. */
export async function loadInbox(page, scrolls = 4) {
  await page.goto(IDLE_URL, { waitUntil: 'domcontentloaded' });
  await jitter(4000, 6000);
  const list = page.locator('.msg-conversations-container__conversations-list, ul.msg-conversations-container__conversations-list').first();
  const box = await list.boundingBox().catch(() => null);
  if (!box) return;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300));
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, rand(700, 1100));
    await jitter(1500, 3000);
  }
}

/** Scroll the connections page; returns profiles found in the DOM (fallback if no JSON is intercepted). */
export async function loadConnections(page, maxScrolls = 25) {
  await page.goto('https://www.linkedin.com/mynetwork/invite-connect/connections/', { waitUntil: 'domcontentloaded' });
  await jitter(4000, 6000);
  let lastCount = 0;
  let stable = 0;
  for (let i = 0; i < maxScrolls && stable < 3; i++) {
    await page.mouse.wheel(0, rand(900, 1400));
    await jitter(1800, 3500);
    const more = page.getByRole('button', { name: /show more results/i });
    if (await more.isVisible().catch(() => false)) { await more.click().catch(() => {}); await jitter(2000, 3000); }
    const count = await page.locator('main a[href*="/in/"]').count();
    stable = count === lastCount ? stable + 1 : 0;
    lastCount = count;
  }
  return page.evaluate(() => {
    const out = new Map();
    for (const a of document.querySelectorAll('main a[href*="/in/"]')) {
      const m = a.href.match(/linkedin\.com\/in\/([^/?#]+)/);
      if (!m) continue;
      const text = (a.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!text.length) continue;
      const prev = out.get(m[1]);
      if (prev && prev.name) continue;
      const card = a.closest('li, [data-view-name], div');
      const lines = (card?.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const img = card?.querySelector('img')?.src ?? null;
      out.set(m[1], { publicId: decodeURIComponent(m[1]), name: text[0], headline: lines.find((l) => l !== text[0] && l.length > 3 && !/^message$/i.test(l)) ?? '', avatarUrl: img });
    }
    return [...out.values()];
  });
}
