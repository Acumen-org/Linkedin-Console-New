// UI actions performed in the bridge's own window. Background work (inbox, connections) runs at human
// pace. Sending runs at human pace with SEND_MODE=human, otherwise as fast as the page allows.
// Selectors are role/label-first with LinkedIn class fallbacks. If LinkedIn changes its UI,
// this is the file to update (see docs/bridge-maintenance.md). Self-healing covers the gap.
import type { FileRef } from '@linkedin-console/contracts';
import type { Locator, Page } from 'patchright';
import type { Healer } from './heal.ts';
import type { DomThread } from './inbox-dom.ts';

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
  /**
   * Called between scrolls so a waiting teammate send can go out mid-sync instead of hanging. Returns true
   * when a send actually ran (which navigates the page away), so the loader reopens its list and carries on.
   */
  yieldToSends?: () => Promise<boolean>;
  /** Called with each newly collected batch as a long list scrolls, so progress is saved even if the tab crashes. */
  onProfiles?: (profiles: DomProfile[]) => Promise<void> | void;
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
    async loadInbox(
      page: Page,
      { scrolls = 4, target = 0, onProgress, yieldToSends }: LoadOptions & { scrolls?: number; target?: number } = {},
    ): Promise<DomThread[]> {
      await navigate(page, IDLE_URL);
      await jitter(4000, 6000);
      const list = page.locator('.msg-conversations-container__conversations-list').first();
      const box = await list.boundingBox().catch(() => null);
      if (!box) return [];
      await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 300));
      const listed = () =>
        page.locator('a[href*="/messaging/thread/"]').evaluateAll((as) => new Set(as.map((a) => (a as HTMLAnchorElement).pathname)).size);
      // About 10 more conversations per scroll: enough scrolls for the target (all chats: up to 400).
      const maxScrolls = target ? Math.min(400, Math.ceil(target / 8) + 10) : scrolls;
      // Every card the list showed, collected as it scrolls (a long list may drop the ones far above).
      const cards = new Map<string, DomThread>();
      const collect = async () => {
        const found = await page
          .locator('a[href*="/messaging/thread/"]')
          .evaluateAll((as) =>
            as.map((a) => {
              const card = (a.closest('li') ?? a) as HTMLElement;
              const img = card.querySelector('img');
              return {
                path: (a as HTMLAnchorElement).pathname,
                lines: card.innerText
                  .split('\n')
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .slice(0, 8),
                avatarUrl: img?.src?.startsWith('https://') ? img.src : null,
              };
            }),
          )
          .catch(() => [] as DomThread[]);
        for (const c of found) if (!cards.has(c.path)) cards.set(c.path, c);
      };
      await collect();
      let last = 0;
      let stable = 0;
      for (let i = 0; i < maxScrolls && stable < 3; i++) {
        // Let a teammate's send go out between scrolls. A send moves the page, so reopen the inbox after.
        if (await yieldToSends?.()) {
          await navigate(page, IDLE_URL);
          await jitter(3000, 5000);
          const b = await list.boundingBox().catch(() => null);
          if (b) await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 300));
          await collect();
        }
        await page.mouse.wheel(0, rand(700, 1100));
        await jitter(1500, 3000);
        await collect();
        if (!target) continue;
        const count = await listed().catch(() => last);
        await onProgress?.(Math.min(count, target), target);
        if (count >= target) break;
        stable = count === last ? stable + 1 : 0;
        last = count;
      }
      return [...cards.values()];
    },

    /**
     * Scroll the connections page (newest first) until the list stops growing or maxScrolls; reports
     * loaded/total (LinkedIn's own "N connections"). Returns the profiles in the DOM (fallback if no JSON
     * is intercepted).
     */
    async loadConnections(page: Page, maxScrolls = 25, { onProgress, yieldToSends, onProfiles }: LoadOptions = {}): Promise<DomProfile[]> {
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
      // Collect the cards currently in the DOM each scroll (a long list drops the ones far above, and the tab
      // can crash on a huge list) and keep them in this Map, so progress survives virtualization and a crash.
      const cards = new Map<string, DomProfile>();
      const collect = async () => {
        const found = await page
          .evaluate(() => {
            const out: { publicId: string; name: string; headline: string; avatarUrl: string | null }[] = [];
            for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('main a[href*="/in/"]'))) {
              const m = a.href.match(/linkedin\.com\/in\/([^/?#]+)/);
              if (!m) continue;
              const text = (a.innerText || '')
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean);
              if (!text.length) continue;
              const card = a.closest<HTMLElement>('li') ?? a.closest<HTMLElement>('[data-view-name], div');
              const lines = (card?.innerText || '')
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean);
              out.push({
                publicId: decodeURIComponent(m[1]),
                name: text[0],
                headline: lines.find((l) => l !== text[0] && l.length > 3 && !/^message$/i.test(l)) ?? '',
                avatarUrl: card?.querySelector('img')?.src ?? null,
              });
              // Drop the card from the DOM once captured: a huge connection list (thousands) otherwise grows the
              // page until the tab runs out of memory and crashes. New cards keep loading below as we scroll.
              a.closest<HTMLElement>('li')?.remove();
            }
            return out;
          })
          .catch(() => [] as DomProfile[]);
        for (const c of found) if (c.name && !cards.get(c.publicId)?.name) cards.set(c.publicId, c);
      };
      await collect();
      let emitted = 0;
      let lastCount = 0;
      let stable = 0;
      const flush = async () => {
        if (onProfiles && cards.size > emitted) {
          await onProfiles([...cards.values()].slice(emitted)); // only the new ones; saved as we go
          emitted = cards.size;
        }
      };
      for (let i = 0; i < maxScrolls && stable < 3; i++) {
        if (await yieldToSends?.()) {
          await navigate(page, CONNECTIONS_URL);
          await jitter(3000, 5000);
        }
        await page.mouse.wheel(0, rand(900, 1400));
        await jitter(1800, 3500);
        const more = page.getByRole('button', { name: /show more results/i });
        if (await more.isVisible().catch(() => false)) {
          await more.click().catch(() => {});
          await jitter(2000, 3000);
        }
        await collect();
        await flush();
        const count = cards.size;
        await onProgress?.(count, total);
        if (total && count >= total) break;
        stable = count === lastCount ? stable + 1 : 0;
        lastCount = count;
      }
      await flush();
      return [...cards.values()];
    },
  };
}

export type Actions = ReturnType<typeof createActions>;
