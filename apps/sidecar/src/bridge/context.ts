import type { BridgeSessionStatus, LiSelf } from '@linkedin-console/contracts';
import type { Browser, BrowserContext, Page } from 'patchright';
import type { SharedState } from '../liveview/server.ts';
import { logger } from '../logger.ts';
import type { Actions } from './actions.ts';
import type { Streams } from './streams.ts';

export interface RequestTemplate {
  url: string;
  headers: Record<string, string>;
  /** POST body (send template only), without the original conversation and text. */
  body?: string;
}

export type Priority = 'high' | 'normal';

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
    /** Conversations LinkedIn's data described since the current conversation list load started. */
    recognisedConversations: Set<string>;
    /** LinkedIn's own GraphQL requests, captured so we can re-run them quietly. */
    templates: Partial<Record<'messages' | 'conversations' | 'send', RequestTemplate>>;
  };
  /**
   * Runs UI actions in the bridge window one at a time (LinkedIn should see one human, not parallel
   * clicks). 'high' jumps the queue: a teammate's send never waits behind background syncs.
   */
  exclusive: ExclusiveRunner;
  /** Short hold on the bridge page: one navigation or one in-page request at a time. */
  pageLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ExclusiveRunner {
  <T>(fn: () => Promise<T>, priority?: Priority): Promise<T>;
  /** Is a teammate's send (a 'high' job) waiting behind the running job? */
  highPending(): boolean;
  /**
   * Run any waiting 'high' jobs right now, from inside a long-running 'normal' job (e.g. a background sync)
   * at a safe point — so a teammate's send goes out within seconds instead of waiting for the sync to finish.
   */
  runPendingHigh(): Promise<void>;
}

/** One job at a time; queued 'high' jobs run before queued 'normal' ones. */
export function createExclusiveRunner(label = 'browser action'): ExclusiveRunner {
  const queues: Record<Priority, (() => Promise<void>)[]> = { high: [], normal: [] };
  let running = false;
  async function drain() {
    running = true;
    for (let job = queues.high.shift() ?? queues.normal.shift(); job; job = queues.high.shift() ?? queues.normal.shift()) await job();
    running = false;
  }
  const exclusive = ((fn, priority: Priority = 'normal') =>
    new Promise((resolve, reject) => {
      queues[priority].push(() =>
        Promise.resolve()
          .then(fn)
          .then(resolve, (err) => {
            logger.warn({ err }, `${label} failed`);
            reject(err);
          }),
      );
      if (!running) drain();
    })) as ExclusiveRunner;
  exclusive.highPending = () => queues.high.length > 0;
  exclusive.runPendingHigh = async () => {
    for (let job = queues.high.shift(); job; job = queues.high.shift()) await job();
  };
  return exclusive;
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

/** Runs at most `max` jobs at once; the rest wait in order. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    // A freed slot is handed straight to the next waiting job, so newcomers can't overtake it.
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
