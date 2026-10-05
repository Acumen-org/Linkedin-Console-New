// READ path: everything LinkedIn's page loads (HTTP JSON + realtime stream) → normalized events.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LiMessage } from '@linkunify/contracts';
import type { Request } from 'patchright';
import { logger } from '../logger.ts';
import { type BridgeContext, createDedupe } from './context.ts';
import { extract, parseSse } from './extract.ts';

const LINKEDIN_DATA = /^https:\/\/www\.linkedin\.com\/(voyager\/api|realtime)/;

interface Waiter {
  text: string;
  threadId?: string;
  since: number;
  resolve: (m: LiMessage | null) => void;
}

const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function createReader(ctx: BridgeContext) {
  const fresh = createDedupe();
  const waiters = new Set<Waiter>();

  /** Resolves when LinkedIn shows our just-sent message (or null after the timeout). */
  function waitForOutbound(opts: { text: string; threadId?: string; since: number; timeoutMs?: number }) {
    return new Promise<LiMessage | null>((resolve) => {
      const w: Waiter = { text: norm(opts.text), threadId: opts.threadId, since: opts.since, resolve };
      waiters.add(w);
      setTimeout(() => {
        if (waiters.delete(w)) resolve(null);
      }, opts.timeoutMs ?? 30_000);
    });
  }

  function checkWaiters(messages: LiMessage[]) {
    for (const m of messages) {
      if (!m.fromSelf) continue;
      for (const w of waiters) {
        const sameThread = !w.threadId || (m.conversationUrn ?? '').includes(w.threadId);
        const sameText = w.text ? norm(m.text) === w.text : m.attachments.length > 0;
        if (sameThread && sameText && (m.sentAt ?? Date.now()) >= w.since - 60_000) {
          waiters.delete(w);
          w.resolve(m);
        }
      }
    }
  }

  async function saveCapture(json: unknown, source: string) {
    const dir = path.join(ctx.filesDir, 'capture', ctx.accountId);
    await fs.mkdir(dir, { recursive: true });
    const slug = source
      .replace(/^https:\/\/www\.linkedin\.com/, '')
      .replace(/[^\w]+/g, '_')
      .slice(0, 80);
    await fs.writeFile(path.join(dir, `${Date.now()}-${slug}.json`), JSON.stringify(json));
  }

  async function handleJson(json: unknown, source: string) {
    if (ctx.captureRaw) saveCapture(json, source).catch(() => {});
    const { emit } = ctx.streams;
    const x = extract(json, ctx.state.selfUrn);
    if (!ctx.state.selfUrn && x.selfUrn) ctx.state.selfUrn = x.selfUrn;

    if (x.conversations.length) {
      const items = x.conversations.map(({ messages: _messages, ...c }) => c);
      const changed = items.filter((c) => fresh(`c:${c.urn}:${c.lastActivityAt}:${c.unreadCount}:${c.folder}`));
      if (changed.length) await emit('conversations', changed);
    }
    if (x.messages.length) {
      const msgs = x.messages.filter((m) => m.conversationUrn);
      const changed = msgs.filter((m) =>
        fresh(`m:${m.urn}:${m.text.length}:${m.reactions.map((r) => r.emoji + r.count).join()}:${m.deleted}`),
      );
      if (changed.length) await emit('messages', changed);
      checkWaiters(msgs);
    }
    const seen = x.seen.filter((s) => s.messageUrn && fresh(`s:${s.messageUrn}:${s.participantUrn}`));
    if (seen.length) await emit('seen', seen);
    if (x.typing.length) await emit('typing', x.typing);
    if (x.profiles.length && ctx.state.collectingConnections) {
      await emit('contacts', { connections: true, items: x.profiles.filter((p) => p.urn !== ctx.state.selfUrn) });
    }
  }

  /** Remember LinkedIn's own messaging GraphQL requests so we can replay them without opening threads. */
  function rememberTemplate(req: Request) {
    const url = req.url();
    if (!url.includes('voyagerMessagingGraphQL/graphql')) return;
    const headers = Object.fromEntries(
      Object.entries(req.headers()).filter(([k]) => !/^(cookie|content-length|host|user-agent|referer|:)/i.test(k)),
    );
    let key: 'messages' | 'conversations' | null = null;
    if (/queryId=messengerMessages\./.test(url) && /conversationUrn/.test(url) && !/deliveredAt/.test(url)) key = 'messages';
    else if (/queryId=messengerConversations\./.test(url) && !/syncToken|lastUpdatedBefore/.test(url)) key = 'conversations';
    if (key && ctx.state.templates[key]?.url !== url) {
      ctx.state.templates[key] = { url, headers };
      ctx.streams.redis.set(`li:tpl:${ctx.accountId}`, JSON.stringify(ctx.state.templates)).catch(() => {});
    }
  }

  async function start() {
    ctx.context.on('response', async (res) => {
      const url = res.url();
      if (!LINKEDIN_DATA.test(url)) return;
      if (!(res.headers()['content-type'] ?? '').includes('json')) return;
      try {
        rememberTemplate(res.request());
        await handleJson(await res.json(), url);
      } catch {}
    });

    // Realtime (new messages, typing, seen) arrives as a server-sent event stream on the bridge page.
    const cdp = await ctx.context.newCDPSession(ctx.page);
    await cdp.send('Network.enable');
    const sseBuffers = new Map<string, string>();
    const onPayload = (p: unknown, source: string) => handleJson(p, source).catch((err) => logger.warn({ err }, 'realtime event failed'));

    cdp.on('Network.eventSourceMessageReceived', (e) => {
      try {
        onPayload(JSON.parse(e.data), 'realtime');
      } catch {}
    });
    cdp.on('Network.responseReceived', async (e) => {
      if (!e.response.url.includes('/realtime/connect')) return;
      sseBuffers.set(e.requestId, '');
      try {
        await cdp.send('Network.streamResourceContent', { requestId: e.requestId });
      } catch {}
    });
    cdp.on('Network.dataReceived', (e) => {
      const buffered = sseBuffers.get(e.requestId);
      if (buffered === undefined || !e.data) return;
      const [payloads, rest] = parseSse(buffered + Buffer.from(e.data, 'base64').toString('utf8'));
      sseBuffers.set(e.requestId, rest);
      for (const p of payloads) onPayload(p, 'realtime');
    });
    cdp.on('Network.loadingFinished', (e) => sseBuffers.delete(e.requestId));
    cdp.on('Network.webSocketFrameReceived', (e) => {
      try {
        onPayload(JSON.parse(e.response.payloadData), 'realtime-ws');
      } catch {}
    });
  }

  return { start, waitForOutbound };
}

export type Reader = ReturnType<typeof createReader>;
