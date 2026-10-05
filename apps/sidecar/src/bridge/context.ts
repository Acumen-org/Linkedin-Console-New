import type { BridgeSessionStatus, LiSelf } from '@linkunify/contracts';
import type { Browser, BrowserContext, Page } from 'patchright';
import type { SharedState } from '../liveview/server.ts';
import { logger } from '../logger.ts';
import type { Actions } from './actions.ts';
import type { Streams } from './streams.ts';

export interface RequestTemplate {
  url: string;
  headers: Record<string, string>;
}

/** Everything the bridge modules share for one LinkedIn account. */
export interface BridgeContext {
  accountId: string;
  filesDir: string;
  captureRaw: boolean;
  browser: Browser;
  context: BrowserContext;
  /** The bridge's own background window. */
  page: Page;
  streams: Streams;
  actions: Actions;
  /** State shared with Live View (login status, bridge window id). */
  shared: SharedState;
  state: {
    status: BridgeSessionStatus;
    self: LiSelf | null;
    selfUrn: string | null;
    collectingConnections: boolean;
    /** LinkedIn's own GraphQL requests, captured so we can re-run them quietly. */
    templates: Partial<Record<'messages' | 'conversations', RequestTemplate>>;
  };
  /** Runs browser actions one at a time (LinkedIn should see one human, not parallel clicks). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
}

export function createExclusiveRunner() {
  let chain: Promise<unknown> = Promise.resolve();
  return function exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn) as Promise<T>;
    chain = run.catch((err) => logger.warn({ err }, 'browser action failed'));
    return run;
  };
}

/** Remembers keys for a while to drop duplicate events (same data seen via HTTP and realtime). */
export function createDedupe(max = 8000) {
  const seen = new Map<string, number>();
  return (key: string) => {
    if (seen.has(key)) return false;
    seen.set(key, Date.now());
    if (seen.size > max) for (const k of [...seen.keys()].slice(0, max / 4)) seen.delete(k);
    return true;
  };
}
