// Helpers around Chrome's DevTools HTTP endpoints + a minimal CDP WebSocket client.
import { WebSocket } from 'ws';
import { config } from './config.ts';

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export async function waitForChrome(timeoutMs = 120_000): Promise<{ Browser: string }> {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${config.cdpHttp}/json/version`);
      if (r.ok) return (await r.json()) as { Browser: string };
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error('Chrome did not become ready');
    await sleep(1000);
  }
}

export async function listPages(): Promise<CdpTarget[]> {
  const r = await fetch(`${config.cdpHttp}/json/list`);
  return ((await r.json()) as CdpTarget[]).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
}

export async function newTab(url = 'https://www.linkedin.com/feed/'): Promise<CdpTarget> {
  const r = await fetch(`${config.cdpHttp}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return (await r.json()) as CdpTarget;
}

export async function activateTab(id: string) {
  await fetch(`${config.cdpHttp}/json/activate/${id}`);
}

type Pending = { res: (v: any) => void; rej: (e: Error) => void };

/** Raw CDP session over a target's WebSocket (used by Live View; no Runtime domain). */
export class Cdp {
  private ws: WebSocket;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, (params: any) => void>();
  readonly ready: Promise<void>;
  onClose: (() => void) | null = null;

  constructor(wsUrl: string) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.ready = new Promise((res, rej) => {
      this.ws.once('open', () => res());
      this.ws.once('error', rej);
    });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
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

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not open'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise<T>((res, rej) => this.pending.set(id, { res, rej }));
  }

  on(method: string, fn: (params: any) => void) {
    this.handlers.set(method, fn);
  }

  close() {
    this.onClose = null;
    try {
      this.ws.close();
    } catch {}
  }
}
