// WRITE path: commands from the app (send, start chat, syncs, media downloads).
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CommandResult, FileRef } from '@linkunify/contracts';
import { IDLE_URL, jitter } from './actions.ts';
import type { BridgeContext } from './context.ts';
import { inPageFetch } from './linkedin.ts';
import type { Reader } from './reader.ts';
import type { Command } from './streams.ts';

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MEDIA_HOSTS = /(^|\.)linkedin\.com$|(^|\.)licdn\.com$/;

export function createCommandHandler(ctx: BridgeContext, reader: Reader, checkSession: () => Promise<unknown>) {
  const { page } = ctx;
  const backToIdle = () => page.goto(IDLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const result = (cmd: Command, data: Omit<CommandResult, 'cmdId' | 'type'>) =>
    ctx.streams.emit('result', { cmdId: cmd.cmdId, type: cmd.type, ...data });

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

  async function send(cmd: Extract<Command, { type: 'send_message' | 'start_chat' }>) {
    await jitter(1500, 5000);
    const since = Date.now();
    try {
      const files = await existingFiles(cmd.files);
      if (cmd.type === 'send_message') await ctx.actions.sendInThread(page, { threadId: cmd.threadId, text: cmd.text, files });
      else await ctx.actions.startChat(page, { profileUrl: cmd.profileUrl, text: cmd.text, files });
      const threadId = cmd.type === 'send_message' ? cmd.threadId : undefined;
      const confirmed = await reader.waitForOutbound({ text: cmd.text, threadId, since });
      if (confirmed) {
        await result(cmd, { ok: true, messageUrn: confirmed.urn, conversationUrn: confirmed.conversationUrn });
      } else {
        const visible = cmd.text
          ? await page
              .getByText(cmd.text.slice(0, 60))
              .last()
              .isVisible()
              .catch(() => false)
          : false;
        await result(cmd, visible ? { ok: true } : { ok: false, error: 'Could not confirm the message was sent' });
      }
    } catch (e) {
      await result(cmd, { ok: false, error: (e as Error).message.split('\n')[0] });
    } finally {
      await jitter(1500, 3000);
      await backToIdle();
    }
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
    await jitter(2000, 5000);
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
    if (ctx.state.status !== 'CONNECTED') {
      const status = ctx.state.status.toLowerCase().replace('_', ' ');
      if (cmd.type === 'send_message' || cmd.type === 'start_chat')
        await result(cmd, { ok: false, error: `LinkedIn account is ${status}` });
      return;
    }
    switch (cmd.type) {
      case 'send_message':
      case 'start_chat':
        return ctx.exclusive(() => send(cmd));
      case 'sync_inbox':
        return ctx.exclusive(() => ctx.actions.loadInbox(page, cmd.scrolls ?? 6));
      case 'sync_thread':
        return ctx.exclusive(() => syncThread(cmd));
      case 'mark_read':
        return ctx.exclusive(async () => {
          await ctx.actions.openThread(page, cmd.threadId);
          await backToIdle();
        });
      case 'sync_connections':
        return ctx.exclusive(() => syncConnections(cmd));
    }
  };
}
