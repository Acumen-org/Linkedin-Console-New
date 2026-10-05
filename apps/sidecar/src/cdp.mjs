// Tiny helpers around Chrome's DevTools HTTP endpoints + a minimal CDP websocket client.
import { WebSocket } from 'ws';

export const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitForChrome(timeoutMs = 120_000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${CDP_HTTP}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error('Chrome did not become ready');
    await sleep(1000);
  }
}

export async function listPages() {
  const r = await fetch(`${CDP_HTTP}/json/list`);
  return (await r.json()).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
}

export async function newTab(url = 'https://www.linkedin.com/feed/') {
  const r = await fetch(`${CDP_HTTP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return r.json();
}

export async function activateTab(id) {
  await fetch(`${CDP_HTTP}/json/activate/${id}`);
}

export class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.method)?.(msg.params);
      }
    });
    this.ws.on('close', () => {
      for (const { rej } of this.pending.values()) rej(new Error('CDP closed'));
      this.pending.clear();
      this.onClose?.();
    });
  }
  send(method, params = {}) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not open'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(method, fn) { this.handlers.set(method, fn); }
  close() { this.onClose = null; try { this.ws.close(); } catch {} }
}
