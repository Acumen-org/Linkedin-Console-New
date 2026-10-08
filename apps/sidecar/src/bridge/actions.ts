// UI actions performed in the bridge's own window. Background work (inbox, connections) runs at human
// pace. Sending runs at human pace with SEND_MODE=human, otherwise as fast as the page allows.
// Selectors are role/label-first with LinkedIn class fallbacks. If LinkedIn changes its UI,
// this is the file to update (see docs/bridge-maintenance.md). Self-healing covers the gap.
import type { FileRef } from '@linkedin-console/contracts';
import type { Locator, Page } from 'patchright';
import type { Healer } from './heal.ts';

export const IDLE_URL = 'https://www.linkedin.com/messaging/thread/new/';
const CONNECTIONS_URL = 'https://www.linkedin.com/mynetwork/invite-connect/connections/';
const threadUrl = (threadId: string) => `https://www.linkedin.com/messaging/thread/${threadId}/`;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const jitter = (min: number, max: number) => sleep(min + Math.random() * (max - min));
const rand = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

export interface DomProfile {
  publicId: string;
  name: string;
  headline: string;
  avatarUrl: string | null;
}

const composer = (page: Page) =>
  page
    .locator('div.msg-form__contenteditable[contenteditable="true"]')
    .or(page.getByRole('textbox', { name: /write a message/i }))
    .last();

const sendButton = (page: Page) =>
  page
    .locator('button.msg-form__send-button, button.msg-form__send-btn')
    .or(page.getByRole('button', { name: /^send$/i }))
    .last();

async function waitEnabled(locator: Locator, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await locator.isVisible().catch(() => false)) && (await locator.isEnabled().catch(() => false))) return true;
    await sleep(100);
  }
  return false;
}

/** Progress while a list loads: loaded so far, and the total when known. */
interface LoadOptions {
  onProgress?: (loaded: number, total: number | null) => Promise<void> | void;
}

export interface ActionOptions {
  /** Send without human pauses and typing (paste the text, click Send). */
  fastSend: boolean;
  /** Page navigation (goes through the bridge's page lock). */
  navigate: (page: Page, url: string) => Promise<unknown>;
}

export function createActions(healer: Healer | null, { fastSend, navigate }: ActionOptions) {
  /** A human pause while sending; skipped in fast mode. */
  const sendPause = (min: number, max: number) => (fastSend ? Promise.resolve() : jitter(min, max));
  /** Primary locator, or the self-healed one when LinkedIn changed its UI. */
  async function find(page: Page, key: string, intent: string, primary: Locator, timeout = 20_000) {
    if (healer) return healer.find(page, key, intent, primary, timeout);
    await primary.waitFor({ state: 'visible', timeout });
    return primary;
  }

  async function attachFiles(page: Page, files: FileRef[]) {
    for (const f of files) {
      const isImage = /^image\//.test(f.mime ?? '');
      const scoped = page.locator('.msg-form input[type="file"], .msg-overlay-conversation-bubble input[type="file"]');
      const imageInput = scoped.and(page.locator('[accept*="image"]')).last();
      const fileInput = scoped.and(page.locator(':not([accept*="image"])')).last();
      const anyInput = page.locator('input[type="file"]').last();
      const target = isImage && (await imageInput.count()) ? imageInput : (await fileInput.count()) ? fileInput : anyInput;
      await target.setInputFiles(f.path);
      await sendPause(2000, 3500); // the upload itself is awaited by waiting for an enabled Send button
    }
  }

  async function typeMessage(page: Page, box: Locator, text: string) {
    await box.click();
    await sendPause(400, 900);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Human mode types the start naturally and pastes the rest of long lines; fast mode pastes it all.
      const head = fastSend ? '' : lines[i].slice(0, 60);
      const tail = fastSend ? lines[i] : lines[i].slice(60);
      if (head) await page.keyboard.type(head, { delay: rand(25, 70) });
      if (tail) await page.keyboard.insertText(tail);
      if (i < lines.length - 1) await page.keyboard.press('Shift+Enter');
    }
  }

  async function composeAndSend(page: Page, text: string, files: FileRef[]) {
    const box = await find(page, 'composer', 'the text box of the message composer where you type a reply', composer(page), 25_000);
    await sendPause(800, 2000);
    if (files.length) await attachFiles(page, files);
    if (text) await typeMessage(page, box, text);
    await sendPause(600, 1500);
    const btn = await find(page, 'send', 'the Send button of the message composer', sendButton(page), 10_000);
    if (!(await waitEnabled(btn, 60_000))) throw new Error('Send button never became enabled (upload stuck or UI changed)');
    await btn.click();
  }

  return {
    async sendInThread(page: Page, { threadId, text, files }: { threadId: string; text: string; files: FileRef[] }) {
      await navigate(page, threadUrl(threadId));
      await composeAndSend(page, text, files);
    },

    async startChat(page: Page, { profileUrl, text, files }: { profileUrl: string; text: string; files: FileRef[] }) {
      await navigate(page, profileUrl);
      await sendPause(2000, 4000);
      const primary = page
        .locator('main')
        .getByRole('button', { name: /^message\b/i })
        .or(page.locator('main').getByRole('link', { name: /^message\b/i }))
        .first();
      const btn = await find(
        page,
        'profile-message',
        "the 'Message' button in the profile's top card that opens a chat with this person",
        primary,
      );
      await btn.click();
      await sendPause(1500, 3000);
      await composeAndSend(page, text, files);
    },

    async openThread(page: Page, threadId: string) {
      await navigate(page, threadUrl(threadId));
      await jitter(3000, 5000);
    },

    /**
     * Load the conversation list (without opening any thread) and scroll it to load more: a fixed number of
     * scrolls, or with `target` until that many conversations are listed (or the list stops growing).
     */
    async loadInbox(page: Page, { scrolls = 4, target = 0, onProgress }: LoadOptions & { scrolls?: number; target?: number } = {}) {
      await navigate(page, IDLE_URL);
      await jitter(4000, 6000);
      const list = page.locator('.msg-conversations-container__conversations-list').first();
      const box = await list.boundingBox().catch(() => null);
      if (!box) return;
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300));
      const listed = () =>
        page.locator('a[href*="/messaging/thread/"]').evaluateAll((as) => new Set(as.map((a) => (a as HTMLAnchorElement).pathname)).size);
      const maxScrolls = target ? 40 : scrolls;
      let last = 0;
      let stable = 0;
      for (let i = 0; i < maxScrolls && stable < 3; i++) {
        await page.mouse.wheel(0, rand(700, 1100));
        await jitter(1500, 3000);
        if (!target) continue;
        const count = await listed().catch(() => last);
        await onProgress?.(Math.min(count, target), target);
        if (count >= target) break;
        stable = count === last ? stable + 1 : 0;
        last = count;
      }
    },

    /**
     * Scroll the connections page (newest first) until the list stops growing or maxScrolls; reports
     * loaded/total (LinkedIn's own "N connections"). Returns the profiles in the DOM (fallback if no JSON
     * is intercepted).
     */
    async loadConnections(page: Page, maxScrolls = 25, { onProgress }: LoadOptions = {}): Promise<DomProfile[]> {
      await navigate(page, CONNECTIONS_URL);
      await jitter(4000, 6000);
      const total = await page
        .locator('main')
        .first()
        .evaluate((m) => {
          const match = (m as HTMLElement).innerText.slice(0, 4000).match(/(\d[\d.,\s]*)\s+connections?\b/i);
          return match ? Number(match[1].replace(/[^\d]/g, '')) || null : null;
        })
        .catch(() => null);
      const listed = () =>
        page.locator('main a[href*="/in/"]').evaluateAll((as) => new Set(as.map((a) => (a as HTMLAnchorElement).pathname)).size);
      let lastCount = 0;
      let stable = 0;
      for (let i = 0; i < maxScrolls && stable < 3; i++) {
        await page.mouse.wheel(0, rand(900, 1400));
        await jitter(1800, 3500);
        const more = page.getByRole('button', { name: /show more results/i });
        if (await more.isVisible().catch(() => false)) {
          await more.click().catch(() => {});
          await jitter(2000, 3000);
        }
        const count = await listed().catch(() => lastCount);
        await onProgress?.(count, total);
        if (total && count >= total) break;
        stable = count === lastCount ? stable + 1 : 0;
        lastCount = count;
      }
      return page.evaluate(() => {
        const out = new Map<string, { publicId: string; name: string; headline: string; avatarUrl: string | null }>();
        for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('main a[href*="/in/"]'))) {
          const m = a.href.match(/linkedin\.com\/in\/([^/?#]+)/);
          if (!m) continue;
          const text = (a.innerText || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          if (!text.length || out.get(m[1])?.name) continue;
          const card = a.closest<HTMLElement>('li, [data-view-name], div');
          const lines = (card?.innerText || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
          out.set(m[1], {
            publicId: decodeURIComponent(m[1]),
            name: text[0],
            headline: lines.find((l) => l !== text[0] && l.length > 3 && !/^message$/i.test(l)) ?? '',
            avatarUrl: card?.querySelector('img')?.src ?? null,
          });
        }
        return [...out.values()];
      });
    },
  };
}

export type Actions = ReturnType<typeof createActions>;
