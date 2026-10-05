// The bridge: the only code that talks to LinkedIn for this account.
//  - attaches to the pod's Chrome over CDP (Patchright, which hides the usual automation leaks)
//  - keeps its own background window so it never disturbs what humans see in Live View
//  - READ: intercepts LinkedIn's own JSON + realtime stream → normalized events → Redis
//  - WRITE: runs commands (send, start chat, sync…) one at a time at human pace
//  - HEALTH: reports CONNECTED / AWAITING_LOGIN / NEEDS_ATTENTION every minute
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'patchright';
import { CDP_HTTP, sleep } from '../cdp.mjs';
import { extract, parseSse, profileUrnFrom } from './extract.mjs';
import * as act from './actions.mjs';
import { createHealer } from './heal.mjs';

const CHALLENGE_RE = /linkedin\.com\/(checkpoint|authwall|uas\/login|login)/;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export async function startBridge({ accountId, streams, state, filesDir, captureRaw }) {
  const { emit, reply, redis } = streams;
  act.setHealer(createHealer({ redis }));
  const browser = await chromium.connectOverCDP(CDP_HTTP);
  browser.on('disconnected', () => { console.error('[bridge] Chrome disconnected, exiting for restart'); process.exit(1); });
  const context = browser.contexts()[0];

  // ---------- bridge window ----------
  const page = await openBridgeWindow(browser, context, redis, accountId);
  state.bridgeTargetId = await targetIdOf(context, page);
  console.log('[bridge] window ready', state.bridgeTargetId);

  let status = 'AWAITING_LOGIN';
  let self = null; // { urn, name, publicId, headline, avatarUrl }
  let selfUrn = null;
  let collectingConnections = false;
  const templates = JSON.parse((await redis.get(`li:tpl:${accountId}`)) ?? '{}');

  // ---------- exclusive runner (one browser action at a time) ----------
  let chain = Promise.resolve();
  const exclusive = (fn) => (chain = chain.then(fn, fn).catch((e) => { console.error('[bridge]', e.message); throw e; }));

  // ---------- dedupe ----------
  const recent = new Map();
  function fresh(key) {
    if (recent.has(key)) return false;
    recent.set(key, Date.now());
    if (recent.size > 8000) for (const k of [...recent.keys()].slice(0, 2000)) recent.delete(k);
    return true;
  }

  // ---------- outbound confirmations ----------
  const waiters = new Set();
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  function waitForOutbound({ text, threadId, since, timeoutMs = 30_000 }) {
    return new Promise((resolve) => {
      const w = { text: norm(text), threadId, since, resolve };
      waiters.add(w);
      setTimeout(() => { if (waiters.delete(w)) resolve(null); }, timeoutMs);
    });
  }
  function checkWaiters(messages) {
    for (const m of messages) {
      if (!m.fromSelf) continue;
      for (const w of waiters) {
        const sameThread = !w.threadId || (m.conversationUrn ?? '').includes(w.threadId);
        const sameText = w.text ? norm(m.text) === w.text : m.attachments.length > 0;
        if (sameThread && sameText && (m.sentAt ?? Date.now()) >= w.since - 60_000) { waiters.delete(w); w.resolve(m); }
      }
    }
  }

  // ---------- read path ----------
  async function handleJson(json, source) {
    if (captureRaw) saveCapture(json, source).catch(() => {});
    const x = extract(json, selfUrn);
    if (!selfUrn && x.selfUrn) selfUrn = x.selfUrn;

    if (x.conversations.length) {
      const items = x.conversations.map(({ messages, ...c }) => c);
      const changed = items.filter((c) => fresh(`c:${c.urn}:${c.lastActivityAt}:${c.unreadCount}:${c.folder}`));
      if (changed.length) await emit('conversations', changed);
    }
    if (x.messages.length) {
      const msgs = x.messages.filter((m) => m.conversationUrn);
      const changed = msgs.filter((m) => fresh(`m:${m.urn}:${m.text.length}:${m.reactions.map((r) => r.emoji + r.count).join()}:${m.deleted}`));
      if (changed.length) await emit('messages', changed);
      checkWaiters(msgs);
    }
    if (x.seen.length) await emit('seen', x.seen.filter((s) => s.messageUrn && fresh(`s:${s.messageUrn}:${s.participantUrn}`)));
    if (x.typing.length) await emit('typing', x.typing);
    if (x.profiles.length && collectingConnections) {
      await emit('contacts', { connections: true, items: x.profiles.filter((p) => p.urn !== selfUrn) });
    }
  }

  async function saveCapture(json, source) {
    const dir = path.join(filesDir, 'capture', accountId);
    await fs.mkdir(dir, { recursive: true });
    const slug = source.replace(/^https:\/\/www\.linkedin\.com/, '').replace(/[^\w]+/g, '_').slice(0, 80);
    await fs.writeFile(path.join(dir, `${Date.now()}-${slug}.json`), JSON.stringify(json));
  }

  function rememberTemplate(req) {
    const url = req.url();
    if (!url.includes('voyagerMessagingGraphQL/graphql')) return;
    const headers = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !/^(cookie|content-length|host|user-agent|referer|:)/i.test(k)));
    let key = null;
    if (/queryId=messengerMessages\./.test(url) && /conversationUrn/.test(url) && !/deliveredAt/.test(url)) key = 'messages';
    else if (/queryId=messengerConversations\./.test(url) && !/syncToken|lastUpdatedBefore/.test(url)) key = 'conversations';
    if (key && templates[key]?.url !== url) {
      templates[key] = { url, headers };
      redis.set(`li:tpl:${accountId}`, JSON.stringify(templates)).catch(() => {});
    }
  }

  context.on('response', async (res) => {
    const url = res.url();
    if (!/^https:\/\/www\.linkedin\.com\/(voyager\/api|realtime)/.test(url)) return;
    const ct = res.headers()['content-type'] ?? '';
    if (!ct.includes('json')) return;
    try {
      rememberTemplate(res.request());
      const json = await res.json();
      await handleJson(json, url);
    } catch {}
  });

  // Realtime (new messages, typing, seen) arrives as a server-sent event stream.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const sseBuffers = new Map();
  cdp.on('Network.eventSourceMessageReceived', (e) => {
    try { handleJson(JSON.parse(e.data), 'realtime'); } catch {}
  });
  cdp.on('Network.responseReceived', async (e) => {
    if (!e.response.url.includes('/realtime/connect')) return;
    sseBuffers.set(e.requestId, '');
    try { await cdp.send('Network.streamResourceContent', { requestId: e.requestId }); } catch {}
  });
  cdp.on('Network.dataReceived', (e) => {
    if (!sseBuffers.has(e.requestId) || !e.data) return;
    const [payloads, rest] = parseSse(sseBuffers.get(e.requestId) + Buffer.from(e.data, 'base64').toString('utf8'));
    sseBuffers.set(e.requestId, rest);
    for (const p of payloads) handleJson(p, 'realtime').catch(() => {});
  });
  cdp.on('Network.loadingFinished', (e) => sseBuffers.delete(e.requestId));
  cdp.on('Network.webSocketFrameReceived', (e) => {
    try { handleJson(JSON.parse(e.response.payloadData), 'realtime-ws'); } catch {}
  });

  // ---------- in-page requests (run as the logged-in page, same as LinkedIn's own JS) ----------
  async function csrf() {
    const c = (await context.cookies('https://www.linkedin.com')).find((k) => k.name === 'JSESSIONID');
    return c?.value?.replace(/"/g, '') ?? '';
  }
  async function ensureOnLinkedIn() {
    if (!page.url().startsWith('https://www.linkedin.com/')) await page.goto(act.IDLE_URL, { waitUntil: 'domcontentloaded' });
  }
  async function inPageFetch(url, headers = {}) {
    await ensureOnLinkedIn();
    const token = await csrf();
    return page.evaluate(async ({ url, headers }) => {
      const r = await fetch(url, { headers, credentials: 'include' });
      return { status: r.status, text: r.status === 200 ? await r.text() : '' };
    }, { url, headers: { ...headers, 'csrf-token': token } });
  }
  async function voyager(pathAndQuery) {
    const r = await inPageFetch(`https://www.linkedin.com/voyager/api${pathAndQuery}`, {
      accept: 'application/vnd.linkedin.normalized+json+2.1', 'x-restli-protocol-version': '2.0.0',
    });
    return { status: r.status, json: r.text ? JSON.parse(r.text) : null };
  }

  async function loadSelf() {
    const { status: st, json } = await voyager('/me');
    if (st !== 200 || !json) return st;
    const x = extract(json);
    const p = x.profiles[0];
    const urn = p?.urn ?? profileUrnFrom(JSON.stringify(json));
    if (urn) {
      selfUrn = urn;
      self = { urn, name: p?.name ?? null, publicId: p?.publicId ?? null, headline: p?.headline ?? null, avatarUrl: p?.avatarUrl ?? null };
    }
    return st;
  }

  // ---------- health ----------
  async function checkSession() {
    const cookies = await context.cookies('https://www.linkedin.com');
    const hasSession = cookies.some((c) => c.name === 'li_at' && c.value);
    const challenged = context.pages().some((p) => CHALLENGE_RE.test(p.url()) && p !== page) || CHALLENGE_RE.test(page.url());
    const ever = (await redis.get(`li:ever:${accountId}`)) === '1';
    let next = hasSession && !challenged ? 'CONNECTED' : ever ? 'NEEDS_ATTENTION' : 'AWAITING_LOGIN';

    if (next === 'CONNECTED' && (status !== 'CONNECTED' || !self || Math.random() < 0.1)) {
      const st = await exclusive(async () => { await ensureOnLinkedIn(); return loadSelf(); }).catch(() => 0);
      if (st === 401 || st === 403) next = ever ? 'NEEDS_ATTENTION' : 'AWAITING_LOGIN';
    }

    const becameConnected = next === 'CONNECTED' && status !== 'CONNECTED';
    status = next;
    await emit('session', { status, self });
    if (becameConnected) {
      await redis.set(`li:ever:${accountId}`, '1');
      console.log('[bridge] connected as', self?.name ?? selfUrn);
      exclusive(() => act.loadInbox(page, 6)).catch(() => {});
    }
    return status;
  }

  (async function healthLoop() {
    for (;;) {
      try { await checkSession(); } catch (e) { console.error('[bridge] health', e.message); }
      await sleep(status === 'CONNECTED' ? 50_000 + Math.random() * 20_000 : 5_000);
    }
  })();

  // Periodic reconcile: refresh the conversation list quietly (no thread gets opened).
  (async function reconcileLoop() {
    await sleep(5 * 60_000);
    for (;;) {
      if (status === 'CONNECTED') {
        await exclusive(async () => {
          if (templates.conversations) {
            const r = await inPageFetch(templates.conversations.url, templates.conversations.headers);
            if (r.status !== 200) delete templates.conversations;
          } else {
            await act.loadInbox(page, 1);
          }
        }).catch(() => {});
      }
      await sleep(6 * 60_000 + Math.random() * 6 * 60_000);
    }
  })();

  // ---------- commands ----------
  const result = (cmd, data) => emit('result', { cmdId: cmd.cmdId, type: cmd.type, ...data });

  async function handleCommand(cmd) {
    if (cmd.type === 'check_session') return checkSession();
    if (status !== 'CONNECTED' && cmd.type !== 'fetch_media') {
      if (cmd.cmdId) await result(cmd, { ok: false, error: `LinkedIn account is ${status.toLowerCase().replace('_', ' ')}` });
      return;
    }
    switch (cmd.type) {
      case 'send_message':
      case 'start_chat':
        return exclusive(async () => {
          await act.jitter(1500, 5000);
          const since = Date.now();
          try {
            const files = await existingFiles(cmd.files);
            if (cmd.type === 'send_message') await act.sendInThread(page, { threadId: cmd.threadId, text: cmd.text, files });
            else await act.startChat(page, { profileUrl: cmd.profileUrl, text: cmd.text, files });
            const confirmed = await waitForOutbound({ text: cmd.text, threadId: cmd.threadId, since });
            if (confirmed) {
              await result(cmd, { ok: true, messageUrn: confirmed.urn, conversationUrn: confirmed.conversationUrn });
            } else {
              const visible = cmd.text ? await page.getByText(cmd.text.slice(0, 60)).last().isVisible().catch(() => false) : false;
              await result(cmd, visible ? { ok: true } : { ok: false, error: 'Could not confirm the message was sent' });
            }
          } catch (e) {
            await result(cmd, { ok: false, error: e.message.split('\n')[0] });
          } finally {
            await act.jitter(1500, 3000);
            await page.goto(act.IDLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          }
        });

      case 'sync_inbox':
        return exclusive(() => act.loadInbox(page, cmd.scrolls ?? 6));

      case 'sync_thread':
        return exclusive(async () => {
          if (templates.messages) {
            const encoded = encodeURIComponent(cmd.conversationUrn);
            const url = templates.messages.url.replace(/conversationUrn:urn%3Ali%3Amsg_conversation%3A%28.*?%29(?=[,)&]|$)/, `conversationUrn:${encoded}`);
            const r = await inPageFetch(url, templates.messages.headers);
            if (r.status === 200) return;
            delete templates.messages;
          }
          // Without a template, opening the thread is the only way (it marks it read), so only when allowed.
          if (cmd.allowOpen && cmd.threadId) {
            await act.openThread(page, cmd.threadId);
            await page.goto(act.IDLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          }
          await act.jitter(2000, 5000);
        });

      case 'mark_read':
        return exclusive(async () => {
          await act.openThread(page, cmd.threadId);
          await page.goto(act.IDLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
        });

      case 'sync_connections':
        return exclusive(async () => {
          collectingConnections = true;
          try {
            const domProfiles = await act.loadConnections(page, cmd.maxScrolls ?? 25);
            if (domProfiles.length) {
              await emit('contacts', {
                connections: true,
                items: domProfiles.map((p) => ({ ...p, urn: `public:${p.publicId}`, profileUrl: `https://www.linkedin.com/in/${p.publicId}/` })),
              });
            }
          } finally {
            collectingConnections = false;
            await page.goto(act.IDLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
          }
        });

      case 'fetch_media':
        return fetchMedia(cmd);
    }
  }

  async function existingFiles(files = []) {
    const out = [];
    for (const f of files) {
      if (!path.resolve(f.path).startsWith(path.resolve(filesDir))) throw new Error('file outside files dir');
      await fs.access(f.path);
      out.push(f);
    }
    return out;
  }

  // Downloads an attachment with the account's cookies and stores it for the app to serve.
  async function fetchMedia(cmd) {
    try {
      const u = new URL(cmd.url);
      if (!/(^|\.)linkedin\.com$|(^|\.)licdn\.com$/.test(u.hostname)) throw new Error('host not allowed');
      const res = await context.request.get(cmd.url, { timeout: 60_000, maxRedirects: 5 });
      if (!res.ok()) throw new Error(`download failed (${res.status()})`);
      const body = await res.body();
      if (body.length > MAX_MEDIA_BYTES) throw new Error('file too large');
      const dir = path.join(filesDir, 'media', accountId);
      await fs.mkdir(dir, { recursive: true });
      const name = crypto.createHash('sha1').update(cmd.url).digest('hex');
      await fs.writeFile(path.join(dir, name), body);
      await reply(cmd.cmdId, { ok: true, path: path.join(dir, name), mime: res.headers()['content-type'] ?? 'application/octet-stream', size: body.length });
    } catch (e) {
      await reply(cmd.cmdId, { ok: false, error: e.message });
    }
  }

  streams.consume(handleCommand);
  return { getStatus: () => status };
}

async function targetIdOf(context, page) {
  const s = await context.newCDPSession(page);
  const { targetInfo } = await s.send('Target.getTargetInfo');
  await s.detach().catch(() => {});
  return targetInfo.targetId;
}

async function openBridgeWindow(browser, context, redis, accountId) {
  // Reuse our window if it survived a sidecar restart.
  const savedId = await redis.get(`li:bridge-target:${accountId}`);
  if (savedId) {
    for (const p of context.pages()) {
      if (await targetIdOf(context, p).catch(() => null) === savedId) return p;
    }
  }
  const pagePromise = context.waitForEvent('page', { timeout: 15_000 });
  const bs = await browser.newBrowserCDPSession();
  await bs.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
  const page = await pagePromise;
  await redis.set(`li:bridge-target:${accountId}`, await targetIdOf(context, page));
  return page;
}
