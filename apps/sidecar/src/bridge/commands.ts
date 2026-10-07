// WRITE path: commands from the app (send, start chat, syncs, media downloads).
//  - Sends run first, in order, one at a time. A text reply goes out with LinkedIn's own send request
//    (about one round trip); attachments, new chats and the very first send use the UI.
//  - Background syncs run one at a time at human pace, behind any waiting send.
//  - Media downloads and session checks don't queue at all.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult, FileRef } from '@linkunify/contracts';
import { config } from '../config.ts';
import { IDLE_URL, jitter } from './actions.ts';
import { type BridgeContext, createExclusiveRunner } from './context.ts';
import { inPageFetch, sendViaApi } from './linkedin.ts';
import type { Reader } from './reader.ts';
import type { Command } from './streams.ts';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MEDIA_HOSTS = /(^|\.)linkedin\.com$|(^|\.)licdn\.com$/;
/** A send that waited longer than this is not sent any more (the app marks it failed after 10 minutes). */
const MAX_SEND_AGE_MS = 5 * 60_000;

type SendCommand = Extract<Command, { type: 'send_message' | 'start_chat' }>;
type Outcome = Omit<CommandResult, 'cmdId' | 'type'>;

export function createCommandHandler(ctx: BridgeContext, reader: Reader, checkSession: () => Promise<unknown>) {
  const { page } = ctx;
  const fast = config.sendMode === 'fast';
  const sendPause = (min: number, max: number) => (fast ? Promise.resolve() : jitter(min, max));
  const sends = createExclusiveRunner('send');
  const background = createExclusiveRunner('background command');
  const backToIdle = () => ctx.pageLock(() => page.goto(IDLE_URL, { waitUntil: 'domcontentloaded' })).catch(() => {});
  const result = (cmd: Command, data: Outcome) => ctx.streams.emit('result', { cmdId: cmd.cmdId, type: cmd.type, ...data });

  async function existingFiles(files: FileRef[] = []) {
    for (const f of files) {
      if (!path.resolve(f.path).startsWith(path.resolve(ctx.filesDir))) throw new Error('file outside files dir');
      await fs.access(f.path);
    }
    return files;
  }

  /** Downloads an attachment with the account's cookies and stores it for the app to serve. */
  async function fetchMedia(cmd: Extract<Command, { type: 'fetch_media' }>) {
    try {
      if (!MEDIA_HOSTS.test(new URL(cmd.url).hostname)) throw new Error('host not allowed');
      const res = await ctx.context.request.get(cmd.url, { timeout: 60_000, maxRedirects: 5 });
      if (!res.ok()) throw new Error(`download failed (${res.status()})`);
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
    if (res.status === 429) return { ok: false, error: 'LinkedIn is limiting this account right now; try again later' };
    if (res.status >= 500) {
      const seen = await echo();
      return seen
        ? { ok: true, messageUrn: seen.urn, conversationUrn: seen.conversationUrn }
        : { ok: false, error: `LinkedIn error (${res.status})` };
    }
    // Rejected (LinkedIn changed the request): forget it; the UI sends this one and teaches the new format.
    reader.dropSendTemplate();
    return null;
  }

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

  async function syncThread(cmd: Extract<Command, { type: 'sync_thread' }>) {
    const tpl = ctx.state.templates.messages;
    if (tpl) {
      const url = tpl.url.replace(
        /conversationUrn:urn%3Ali%3Amsg_conversation%3A%28.*?%29(?=[,)&]|$)/,
        `conversationUrn:${encodeURIComponent(cmd.conversationUrn)}`,
      );
      const r = await inPageFetch(ctx, url, tpl.headers);
      if (r.status === 200) return;
      delete ctx.state.templates.messages;
    }
    // Without a template, opening the thread is the only way (it marks it read), so only when allowed.
    if (cmd.allowOpen && cmd.threadId) {
      await ctx.actions.openThread(page, cmd.threadId);
      await backToIdle();
    }
  }

  async function syncConnections(cmd: Extract<Command, { type: 'sync_connections' }>) {
    ctx.state.collectingConnections = true;
    try {
      const fromDom = await ctx.actions.loadConnections(page, cmd.maxScrolls ?? 25);
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

  return async function handle(cmd: Command): Promise<unknown> {
    if (cmd.type === 'check_session') return checkSession();
    if (cmd.type === 'fetch_media') return fetchMedia(cmd);
    if (cmd.type === 'send_message' || cmd.type === 'start_chat') return sends(() => send(cmd));
    return background(async () => {
      if (ctx.state.status !== 'CONNECTED') return;
      switch (cmd.type) {
        case 'sync_inbox':
          return ctx.exclusive(() => ctx.actions.loadInbox(page, cmd.scrolls ?? 6));
        case 'sync_thread':
          await ctx.exclusive(() => syncThread(cmd));
          return jitter(2000, 5000); // pause between history syncs, without holding the window
        case 'mark_read':
          return ctx.exclusive(async () => {
            await ctx.actions.openThread(page, cmd.threadId);
            await backToIdle();
          });
        case 'sync_connections':
          return ctx.exclusive(() => syncConnections(cmd));
      }
    });
  };
}
