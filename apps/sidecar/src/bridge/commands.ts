// WRITE path: commands from the app (send, start chat, syncs, media downloads).
//  - Sends run first, in order, one at a time. A text reply goes out with LinkedIn's own send request
//    (about one round trip); attachments, new chats and the very first send use the UI.
//  - Background syncs run one at a time at human pace, behind any waiting send.
//  - Media downloads and session checks don't queue at all.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult, FileRef, InboxCheck } from '@linkedin-console/contracts';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { IDLE_URL, jitter, sleep } from './actions.ts';
import { type BridgeContext, createExclusiveRunner, createLimiter } from './context.ts';
import { extract } from './extract.ts';
import { conversationsFromPage, threadIdFromPath } from './inbox-dom.ts';
import { encodeUrn, forgetTemplate, hasSessionCookie, inPageFetch, isFormatRejection, sendViaApi } from './linkedin.ts';
import type { Reader } from './reader.ts';
import type { Command } from './streams.ts';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MEDIA_HOSTS = /(^|\.)linkedin\.com$|(^|\.)licdn\.com$/;
/** A send that waited longer than this is not sent any more (the app marks it failed after 10 minutes). */
const MAX_SEND_AGE_MS = 5 * 60_000;
/** LinkedIn's wording when an account hits a limit or is restricted (pauses sending on the account). */
const LIMIT_NOTICE =
  /reached the (weekly |monthly |daily )?limit|exceeded the limit|unusual activity|temporarily restricted|account (has been |is )?restricted|too many requests/i;

type SendCommand = Extract<Command, { type: 'send_message' | 'start_chat' }>;
type Outcome = Omit<CommandResult, 'cmdId' | 'type'>;

export function createCommandHandler(ctx: BridgeContext, reader: Reader, checkSession: () => Promise<unknown>) {
  const { page } = ctx;
  const fast = config.sendMode === 'fast';
  const sendPause = (min: number, max: number) => (fast ? Promise.resolve() : jitter(min, max));
  const sends = createExclusiveRunner('send');
  const background = createExclusiveRunner('background command');
  const downloads = createLimiter(2);
  const backToIdle = () => ctx.pageLock(() => page.goto(IDLE_URL, { waitUntil: 'domcontentloaded' })).catch(() => {});
  // Between scrolls, a long background sync calls this so a waiting teammate send goes out now instead of
  // hanging "sending" until it times out. Returns true when a send ran (the page moved; the loader reopens).
  const yieldToSends = async () => {
    if (!ctx.exclusive.highPending()) return false;
    await ctx.exclusive.runPendingHigh();
    return true;
  };
  const result = (cmd: Command, data: Outcome) => ctx.streams.emit('result', { cmdId: cmd.cmdId, type: cmd.type, ...data });

  async function existingFiles(files: FileRef[] = []) {
    const root = path.resolve(ctx.filesDir);
    for (const f of files) {
      const rel = path.relative(root, path.resolve(f.path));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('file outside files dir');
      await fs.access(f.path);
    }
    return files;
  }

  /**
   * Downloads an attachment with the account's cookies and stores it for the app to serve. At most two at a
   * time (each is held in memory, and this process has 256 MB); every redirect hop must stay on LinkedIn.
   */
  async function fetchMedia(cmd: Extract<Command, { type: 'fetch_media' }>) {
    try {
      let url = cmd.url;
      let res: Awaited<ReturnType<typeof ctx.context.request.get>> | null = null;
      for (let hop = 0; hop <= 5; hop++) {
        if (!MEDIA_HOSTS.test(new URL(url).hostname)) throw new Error('host not allowed');
        res = await ctx.context.request.get(url, { timeout: 60_000, maxRedirects: 0 });
        const location = res.status() >= 300 && res.status() < 400 ? res.headers().location : undefined;
        if (!location) break;
        url = new URL(location, url).toString();
        res = null;
      }
      if (!res) throw new Error('too many redirects');
      if (!res.ok()) throw new Error(`download failed (${res.status()})`);
      if (Number(res.headers()['content-length'] ?? 0) > MAX_MEDIA_BYTES) throw new Error('file too large');
      const body = await res.body();
      if (body.length > MAX_MEDIA_BYTES) throw new Error('file too large');
      const dir = path.join(ctx.filesDir, 'media', ctx.accountId);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, crypto.createHash('sha1').update(cmd.url).digest('hex'));
      await fs.writeFile(file, body);
      await ctx.streams.reply(cmd.cmdId, {
        ok: true,
        path: file,
        mime: res.headers()['content-type'] ?? 'application/octet-stream',
        size: body.length,
      });
    } catch (e) {
      await ctx.streams.reply(cmd.cmdId, { ok: false, error: (e as Error).message });
    }
  }

  /** A text reply through LinkedIn's own send request. Null = no usable template, send through the UI. */
  async function sendDirect(cmd: Extract<Command, { type: 'send_message' }>, since: number): Promise<Outcome | null> {
    const echo = () => reader.waitForOutbound({ text: cmd.text, threadId: cmd.threadId, since, timeoutMs: 15_000 });
    let res: { status: number } | null;
    try {
      res = await sendViaApi(ctx, cmd.conversationUrn, cmd.text);
    } catch {
      // The request may or may not have reached LinkedIn: only LinkedIn's own copy can tell. Never resend blindly.
      const seen = await echo();
      return seen
        ? { ok: true, messageUrn: seen.urn, conversationUrn: seen.conversationUrn }
        : { ok: false, error: 'LinkedIn did not confirm the message' };
    }
    if (!res) return null;
    if (res.status >= 200 && res.status < 300) return { ok: true }; // LinkedIn's copy arrives in a moment and gets matched
    if (res.status === 401) return { ok: false, error: 'LinkedIn session expired' };
    if (res.status === 429) return { ok: false, error: 'LinkedIn is limiting this account right now', warning: 'limited' };
    if (!isFormatRejection(res.status) && res.status < 500) {
      // Refused for this message or recipient (e.g. they can't be messaged): the request format is fine.
      return { ok: false, error: `LinkedIn refused the message (${res.status})` };
    }
    if (res.status >= 500) {
      const seen = await echo();
      return seen
        ? { ok: true, messageUrn: seen.urn, conversationUrn: seen.conversationUrn }
        : { ok: false, error: `LinkedIn error (${res.status})` };
    }
    // Rejected (LinkedIn changed the request): forget it; the UI sends this one and teaches the new format.
    forgetTemplate(ctx, 'send');
    return null;
  }

  /** A LinkedIn notice about limits or restrictions on the page after a send (its text), or null. */
  async function limitNotice(): Promise<string | null> {
    const notice = page.getByText(LIMIT_NOTICE).first();
    if (!(await notice.isVisible().catch(() => false))) return null;
    return ((await notice.innerText().catch(() => '')) || 'limit reached').trim().slice(0, 160);
  }
  const limitOutcome = (notice: string): Outcome => ({
    ok: false,
    error: `LinkedIn: ${notice}`,
    warning: /restrict/i.test(notice) ? 'restricted' : 'limited',
  });

  /** Through the bridge window's UI (jumps ahead of background work). */
  function sendViaUi(cmd: SendCommand, since: number): Promise<Outcome> {
    return ctx.exclusive(async () => {
      try {
        await sendPause(1500, 5000);
        const files = await existingFiles(cmd.files);
        if (cmd.type === 'send_message') await ctx.actions.sendInThread(page, { threadId: cmd.threadId, text: cmd.text, files });
        else await ctx.actions.startChat(page, { profileUrl: cmd.profileUrl, text: cmd.text, files });
        const threadId = cmd.type === 'send_message' ? cmd.threadId : undefined;
        const confirmed = await reader.waitForOutbound({ text: cmd.text, threadId, since });
        if (confirmed) return { ok: true, messageUrn: confirmed.urn, conversationUrn: confirmed.conversationUrn };
        const notice = await limitNotice();
        if (notice) return limitOutcome(notice);
        const firstLine = cmd.text.split('\n').find((l) => l.trim()) ?? '';
        const visible = firstLine
          ? await page
              .getByText(firstLine.trim().slice(0, 60))
              .last()
              .isVisible()
              .catch(() => false)
          : false;
        return visible ? { ok: true } : { ok: false, error: 'Could not confirm the message was sent' };
      } catch (e) {
        // A send that failed because LinkedIn put up a limit notice: report that, so sending gets paused.
        const notice = await limitNotice();
        if (notice) return limitOutcome(notice);
        return { ok: false, error: (e as Error).message.split('\n')[0] };
      } finally {
        await sendPause(1500, 3000);
        await backToIdle();
      }
    }, 'high');
  }

  async function send(cmd: SendCommand) {
    if (Date.now() - cmd.queuedAt > MAX_SEND_AGE_MS) {
      return result(cmd, { ok: false, error: 'Not sent: it waited too long (the LinkedIn account was busy or offline)' });
    }
    if (ctx.state.status !== 'CONNECTED') {
      return result(cmd, { ok: false, error: `LinkedIn account is ${ctx.state.status.toLowerCase().replace('_', ' ')}` });
    }
    const since = Date.now();
    const direct = fast && cmd.type === 'send_message' && cmd.text.trim() && !cmd.files?.length ? await sendDirect(cmd, since) : null;
    await result(cmd, direct ?? (await sendViaUi(cmd, since)));
  }

  /**
   * Whether LinkedIn's answer is this conversation's history. The learned request names the conversation it
   * was learned from: if swapping in ours didn't work, the answer is that other conversation's messages.
   */
  function isHistoryOf(text: string, conversationUrn: string) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return false;
    }
    const messages = extract(json as never, ctx.state.selfUrn).messages;
    // No messages at all is a real (empty) conversation; only another conversation's messages are wrong.
    return !messages.length || messages.some((m) => m.conversationUrn === conversationUrn);
  }

  /** A conversation's recent history, quietly (LinkedIn's own request) or by opening it when allowed. */
  /**
   * Backfill a thread's older messages by replaying LinkedIn's own "load older" request (learned as
   * `messagesOlder`), paging back from `beforeMs` until no older messages remain or `maxPages` is reached.
   * The reader ingests each response automatically (it's a real network request). Quiet: no thread is opened,
   * so nothing is marked read. If the paginated request isn't learned yet, prime it once by opening a thread
   * and scrolling its message pane up (only an already-read thread, so we never mark one read).
   */
  async function backfillThread(cmd: Extract<Command, { type: 'backfill_thread' }>): Promise<Outcome> {
    const tpl = ctx.state.templates.messagesOlder;
    if (!tpl) {
      if (cmd.threadId) {
        await ctx.exclusive(async () => {
          try {
            await ctx.actions.openThread(page, cmd.threadId as string);
            const pane = page.locator('.msg-s-message-list-container, .msg-s-message-list').first();
            const box = await pane.boundingBox().catch(() => null);
            for (let i = 0; i < 4 && box; i++) {
              await page.mouse.move(box.x + box.width / 2, box.y + 60);
              await page.mouse.wheel(0, -1200);
              await jitter(1200, 2200);
            }
          } finally {
            await backToIdle();
          }
        });
      }
      return { ok: false, error: 'learning the older-messages request', conversationUrn: cmd.conversationUrn };
    }
    let before = cmd.beforeMs;
    let fetched = 0;
    let done = false;
    for (let p = 0; p < (cmd.maxPages ?? 5); p++) {
      const url = tpl.url
        .replace(/conversationUrn:urn%3Ali%3Amsg_conversation%3A%28.*?%29(?=[,)&]|$)/, `conversationUrn:${encodeUrn(cmd.conversationUrn)}`)
        .replace(/deliveredAt:\d+/, before != null ? `deliveredAt:${before}` : '$&');
      const r = await inPageFetch(ctx, url, tpl.headers); // the reader ingests the response automatically
      if (r.status === 429)
        return {
          ok: false,
          error: 'LinkedIn is limiting this account right now',
          warning: 'limited',
          conversationUrn: cmd.conversationUrn,
        };
      if (r.status !== 200) {
        if (isFormatRejection(r.status)) forgetTemplate(ctx, 'messagesOlder');
        else return { ok: false, error: `LinkedIn ${r.status}`, conversationUrn: cmd.conversationUrn };
        break;
      }
      const msgs = extract(r.text ? JSON.parse(r.text) : {}).messages;
      const times = msgs.map((m) => Number(m.sentAt)).filter((n) => Number.isFinite(n));
      if (!times.length) {
        done = true;
        break;
      }
      const oldest = Math.min(...times);
      if (before != null && oldest >= before) {
        done = true; // no progress — we've reached the start of the thread
        break;
      }
      before = oldest;
      fetched += msgs.length;
      await sleep(2000 + Math.random() * 2500); // gentle pace between pages
      await yieldToSends();
    }
    return { ok: true, conversationUrn: cmd.conversationUrn, backfill: { oldestMs: before, done, fetched } };
  }

  async function syncThread(cmd: Extract<Command, { type: 'sync_thread' }>): Promise<Outcome> {
    const tpl = ctx.state.templates.messages;
    if (tpl) {
      const url = tpl.url.replace(
        /conversationUrn:urn%3Ali%3Amsg_conversation%3A%28.*?%29(?=[,)&]|$)/,
        // LinkedIn encodes the URN's parentheses too (encodeURIComponent leaves them as is).
        `conversationUrn:${encodeUrn(cmd.conversationUrn)}`,
      );
      const r = await inPageFetch(ctx, url, tpl.headers);
      if (r.status === 200 && isHistoryOf(r.text, cmd.conversationUrn)) return { ok: true, conversationUrn: cmd.conversationUrn };
      if (r.status !== 200 && !isFormatRejection(r.status))
        return { ok: false, error: `LinkedIn ${r.status}`, conversationUrn: cmd.conversationUrn };
      // Rejected, or answered with another conversation (ours couldn't be swapped in): its format changed.
      if (r.status === 200) logger.warn('the learned history request returned another conversation; learning it again');
      forgetTemplate(ctx, 'messages');
    }
    // Without a template, opening the thread is the only way (it marks it read), so only when allowed. Opening
    // one also teaches the template, so the rest go quietly.
    if (cmd.allowOpen && cmd.threadId) {
      await ctx.actions.openThread(page, cmd.threadId);
      await backToIdle();
      return { ok: true, conversationUrn: cmd.conversationUrn };
    }
    return { ok: false, error: 'waiting for a read conversation to learn the history request', conversationUrn: cmd.conversationUrn };
  }

  async function syncConnections(cmd: Extract<Command, { type: 'sync_connections' }>) {
    ctx.state.collectingConnections = true;
    try {
      const onProgress = cmd.progress
        ? (loaded: number, total: number | null) => ctx.streams.emit('progress', { kind: 'connections', loaded, total, done: false })
        : undefined;
      const fromDom = await ctx.actions.loadConnections(page, cmd.maxScrolls ?? 25, { onProgress, yieldToSends });
      if (fromDom.length) {
        await ctx.streams.emit('contacts', {
          connections: true,
          items: fromDom.map((p) => ({ ...p, urn: `public:${p.publicId}`, profileUrl: `https://www.linkedin.com/in/${p.publicId}/` })),
        });
      }
    } finally {
      ctx.state.collectingConnections = false;
      await backToIdle();
    }
  }

  /**
   * Loads the conversation list. Whatever the page listed that LinkedIn's data didn't describe (its format
   * changed, a response was missed) is added from the page itself, and the counts are reported so the app can
   * tell when reading LinkedIn's data stopped working.
   */
  async function syncInbox(cmd: Extract<Command, { type: 'sync_inbox' }>): Promise<InboxCheck> {
    const onProgress = cmd.target
      ? (loaded: number, total: number | null) => ctx.streams.emit('progress', { kind: 'conversations', loaded, total, done: false })
      : undefined;
    ctx.state.recognisedConversations.clear();
    const threads = await ctx.actions.loadInbox(page, { scrolls: cmd.scrolls ?? 6, target: cmd.target ?? 0, onProgress, yieldToSends });
    await sleep(1500); // the last responses are still being read
    const ids = new Set(threads.map((t) => threadIdFromPath(t.path)).filter((id) => id && id !== 'new'));
    const self = ctx.state.selfUrn;
    const fromPage = self ? conversationsFromPage(threads, self, ctx.state.recognisedConversations) : [];
    if (fromPage.length) {
      logger.warn(
        { listed: ids.size, fromPage: fromPage.length },
        "conversations added from the page: LinkedIn's data didn't describe them",
      );
      for (let i = 0; i < fromPage.length; i += 50) await ctx.streams.emit('conversations', fromPage.slice(i, i + 50));
    }
    return { listed: ids.size, recognised: ids.size - fromPage.length, fromPage: fromPage.length };
  }

  /** Background syncs report when they're done (the app tracks first-sync progress and retries). */
  const done = (cmd: Command, outcome: Outcome) => result(cmd, outcome);

  /**
   * Log back in with the stored LinkedIn password after LinkedIn signed the account out. Fills the login form
   * and submits; if LinkedIn then asks for 2FA or a CAPTCHA, we stop and leave it for a person (never solved
   * here). The password is used only to fill the form — never logged.
   */
  async function login(cmd: Extract<Command, { type: 'login' }>) {
    try {
      const outcome = await ctx.pageLock(async () => {
        await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: 60_000 });
        const pass = page.locator('#password');
        if (await pass.count()) {
          const user = page.locator('#username');
          if (await user.count()) await user.fill(cmd.username);
          await pass.fill(cmd.password);
          await page
            .locator('button[type=submit]')
            .first()
            .click()
            .catch(() => {});
          await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});
          await sleep(4000);
        }
        const url = page.url();
        // A human step LinkedIn now wants (one-time code, device check, puzzle): leave it alone.
        const challenged = /\/(checkpoint|challenge)\b|two-step|verification|captcha/i.test(url);
        return { loggedIn: await hasSessionCookie(ctx), challenged };
      });
      await checkSession(); // let the health monitor set CONNECTED (or keep NEEDS_ATTENTION)
      logger.info({ ok: outcome.loggedIn, challenge: outcome.challenged }, 'auto login attempt');
      return done(cmd, {
        ok: outcome.loggedIn,
        error: outcome.loggedIn ? undefined : outcome.challenged ? 'needs a person (2FA or CAPTCHA)' : 'login not accepted',
      });
    } catch (e) {
      return done(cmd, { ok: false, error: (e as Error).message.split('\n')[0] });
    }
  }
  const attempt = async (cmd: Command, fn: () => Promise<unknown>) => {
    try {
      await fn();
      await done(cmd, { ok: true });
    } catch (e) {
      await done(cmd, { ok: false, error: (e as Error).message.split('\n')[0] });
    }
  };

  return async function handle(cmd: Command): Promise<unknown> {
    if (cmd.type === 'check_session') return checkSession();
    if (cmd.type === 'login') return login(cmd); // runs while signed out, so before the CONNECTED-only guard
    if (cmd.type === 'fetch_media') return downloads(() => fetchMedia(cmd));
    if (cmd.type === 'send_message' || cmd.type === 'start_chat') return sends(() => send(cmd));
    // Someone opened this conversation: its history goes before the rest of the background work.
    const priority = cmd.type === 'sync_thread' && cmd.priority ? 'high' : 'normal';
    return background(async () => {
      if (ctx.state.status !== 'CONNECTED') return;
      switch (cmd.type) {
        case 'sync_inbox':
          try {
            const inbox = await ctx.exclusive(() => syncInbox(cmd));
            return done(cmd, { ok: true, inbox });
          } catch (e) {
            return done(cmd, { ok: false, error: (e as Error).message.split('\n')[0] });
          }
        case 'sync_thread': {
          const outcome = await ctx
            .exclusive(() => syncThread(cmd), priority)
            .catch((e: Error) => ({
              ok: false,
              error: e.message.split('\n')[0],
              conversationUrn: cmd.conversationUrn,
            }));
          await done(cmd, outcome);
          return jitter(2000, 5000); // pause between history syncs, without holding the window
        }
        case 'backfill_thread': {
          const outcome = await backfillThread(cmd).catch((e: Error) => ({
            ok: false,
            error: e.message.split('\n')[0],
            conversationUrn: cmd.conversationUrn,
          }));
          await done(cmd, outcome);
          return jitter(2000, 5000);
        }
        case 'mark_read':
          return ctx.exclusive(async () => {
            await ctx.actions.openThread(page, cmd.threadId);
            await backToIdle();
          });
        case 'sync_connections':
          return attempt(cmd, () => ctx.exclusive(() => syncConnections(cmd)));
      }
    }, priority);
  };
}
