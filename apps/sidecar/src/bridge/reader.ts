// READ path: everything LinkedIn's page loads (HTTP JSON + realtime stream) → normalized events.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LiMessage } from '@linkedin-console/contracts';
import type { Request } from 'patchright';
import { logger } from '../logger.ts';
import { type BridgeContext, createDedupe } from './context.ts';
import { extract, parseSse } from './extract.ts';
import { isCreateMessageRequest, scrubSendBody } from './send-template.ts';

const LINKEDIN_DATA = /^https:\/\/www\.linkedin\.com\/(voyager\/api|realtime)/;
/** The responses we use: messaging, the realtime stream, who is logged in, connections. Feed, search and
 * profile pages a teammate browses in Live View are skipped before their (large) bodies are read. */
const USEFUL_DATA = /messag|messeng|realtime|\/voyager\/api\/me\b|connection|relationship/i;
/** A realtime event bigger than this without an event boundary is not SSE we understand: drop it. */
const MAX_SSE_BUFFER = 1024 * 1024;

interface Waiter {
  text: string;
  threadId?: string;
  since: number;
  resolve: (m: LiMessage | null) => void;
}

/** Short fingerprint of a message text (an edit of the same length is still a change). */
const textKey = (text: string) => crypto.createHash('sha1').update(text).digest('base64url').slice(0, 12);

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

  /** ownSend: the response to a create-message request; the message it created is this account's. */
  async function handleJson(json: unknown, source: string, ownSend = false) {
    if (ctx.captureRaw) saveCapture(json, source).catch(() => {});
    const { emit } = ctx.streams;
    const x = extract(json, ctx.state.selfUrn);
    if (!ctx.state.selfUrn && x.selfUrn) ctx.state.selfUrn = x.selfUrn;
    if (ownSend) {
      // LinkedIn's reply to a send may name the sender only by reference: fill in this account. Messages that
      // name someone else (e.g. the other side's last message, included for context) stay theirs.
      const self = ctx.state.self;
      for (const m of x.messages) {
        if (m.senderUrn && m.senderUrn !== ctx.state.selfUrn) continue;
        m.fromSelf = true;
        m.senderUrn ??= ctx.state.selfUrn;
        m.senderName ??= self?.name ?? null;
        m.senderAvatarUrl ??= self?.avatarUrl ?? null;
      }
    }

    if (x.conversations.length) {
      for (const c of x.conversations) ctx.state.recognisedConversations.add(c.urn);
      const items = x.conversations.map(({ messages: _messages, ...c }) => c);
      const changed = items.filter((c) => fresh(`c:${c.urn}:${c.lastActivityAt}:${c.unreadCount}:${c.folder}`));
      if (changed.length) await emit('conversations', changed);
    }
    if (x.messages.length) {
      const msgs = x.messages.filter((m) => m.conversationUrn);
      const changed = msgs.filter((m) =>
        fresh(
          `m:${m.urn}:${textKey(m.text)}:${m.edited}:${m.attachments.length}:${m.reactions.map((r) => r.emoji + r.count).join()}:${m.deleted}`,
        ),
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

  const saveTemplates = () => ctx.streams.redis.set(`li:tpl:${ctx.accountId}`, JSON.stringify(ctx.state.templates)).catch(() => {});
  const replayableHeaders = (req: Request) =>
    Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !/^(cookie|content-length|host|user-agent|referer|:)/i.test(k)));

  /** LinkedIn's own send request (a successful one), for fast sending. See send-template.ts. */
  function rememberSendTemplate(req: Request) {
    if (ctx.state.templates.send?.url === req.url()) return;
    const body = scrubSendBody(req.postData() ?? '');
    if (!body) return;
    ctx.state.templates.send = { url: req.url(), headers: replayableHeaders(req), body };
    saveTemplates();
    logger.info('learned the send request: next text messages go out directly');
  }

  /** Remember LinkedIn's own messaging GraphQL requests so we can replay them without opening threads. */
  function rememberTemplate(req: Request) {
    const url = req.url();
    if (!url.includes('voyagerMessagingGraphQL/graphql')) return;
    const headers = replayableHeaders(req);
    let key: 'messages' | 'messagesOlder' | 'conversations' | null = null;
    // A messengerMessages request WITH a deliveredAt cursor is LinkedIn's "load older messages" request:
    // keep it so we can replay it to backfill a thread's history back to its first message.
    if (/queryId=messengerMessages\./.test(url) && /conversationUrn/.test(url))
      key = /deliveredAt/.test(url) ? 'messagesOlder' : 'messages';
    else if (/queryId=messengerConversations\./.test(url) && !/syncToken|lastUpdatedBefore/.test(url)) key = 'conversations';
    if (key && ctx.state.templates[key]?.url !== url) {
      ctx.state.templates[key] = { url, headers };
      saveTemplates();
    }
  }

  async function start() {
    ctx.context.on('response', async (res) => {
      const url = res.url();
      if (!LINKEDIN_DATA.test(url)) return;
      if (res.ok() && isCreateMessageRequest(res.request().method(), url)) rememberSendTemplate(res.request());
      if (!USEFUL_DATA.test(url)) return;
      // LinkedIn's messaging GraphQL now answers with content-type `application/graphql` (it used to be a
      // `…+json` type); the body is still JSON. Accept both, or every conversation/message response is dropped
      // and only realtime events get through (old chats never sync). res.json() still parses a graphql body.
      if (!/json|graphql/.test(res.headers()['content-type'] ?? '')) return;
      try {
        rememberTemplate(res.request());
        await handleJson(await res.json(), url, isCreateMessageRequest(res.request().method(), url));
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
    const feedSse = (requestId: string, chunk: string) => {
      const buffered = sseBuffers.get(requestId);
      if (buffered === undefined || !chunk) return;
      const [payloads, rest] = parseSse(buffered + chunk);
      sseBuffers.set(requestId, rest.length > MAX_SSE_BUFFER ? '' : rest);
      for (const p of payloads) onPayload(p, 'realtime');
    };
    cdp.on('Network.responseReceived', async (e) => {
      if (!e.response.url.includes('/realtime/connect')) return;
      sseBuffers.set(e.requestId, '');
      try {
        // Events that arrived before streaming was switched on come back as bufferedData.
        const { bufferedData } = (await cdp.send('Network.streamResourceContent', { requestId: e.requestId })) as {
          bufferedData?: string;
        };
        if (bufferedData) feedSse(e.requestId, Buffer.from(bufferedData, 'base64').toString('utf8'));
      } catch {}
    });
    cdp.on('Network.dataReceived', (e) => {
      if (e.data) feedSse(e.requestId, Buffer.from(e.data, 'base64').toString('utf8'));
    });
    // Finished or failed (aborted by a navigation, network drop): forget the stream's buffer either way.
    cdp.on('Network.loadingFinished', (e) => sseBuffers.delete(e.requestId));
    cdp.on('Network.loadingFailed', (e) => sseBuffers.delete(e.requestId));
    cdp.on('Network.webSocketFrameReceived', (e) => {
      try {
        onPayload(JSON.parse(e.response.payloadData), 'realtime-ws');
      } catch {}
    });
  }

  return { start, waitForOutbound };
}

export type Reader = ReturnType<typeof createReader>;
