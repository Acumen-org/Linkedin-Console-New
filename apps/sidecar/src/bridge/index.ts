// The bridge: the only code that talks to LinkedIn for this account.
//  - attaches to the pod's Chrome over CDP (Patchright, which hides the usual automation leaks)
//  - works in its own background window so it never disturbs what humans see in Live View
//  - READ (reader.ts): LinkedIn's own JSON + realtime stream → normalized events → Redis
//  - WRITE (commands.ts): app commands; sends first and fast, background syncs one at a time at human pace
//  - HEALTH (session.ts): CONNECTED / AWAITING_LOGIN / NEEDS_ATTENTION heartbeat
import { chromium, type Page } from 'patchright';
import { config } from '../config.ts';
import type { SharedState } from '../liveview/server.ts';
import { logger } from '../logger.ts';
import { createActions } from './actions.ts';
import { createCommandHandler } from './commands.ts';
import { type BridgeContext, createExclusiveRunner } from './context.ts';
import { createHealer } from './heal.ts';
import { createReader } from './reader.ts';
import { createSessionMonitor } from './session.ts';
import type { Streams } from './streams.ts';
import { openBridgeWindow, targetIdOf } from './window.ts';

export async function startBridge(streams: Streams, shared: SharedState) {
  // Generous timeout: after a server reboot every account's Chrome starts at once and the first launch is slow.
  const browser = await chromium.connectOverCDP(config.cdpHttp, { timeout: 120_000 });
  browser.on('disconnected', () => {
    logger.error('Chrome disconnected, exiting so the container restarts');
    process.exit(1);
  });
  const context = browser.contexts()[0];
  const page = await openBridgeWindow(browser, context, streams.redis, config.accountId);
  // A crashed or closed bridge tab would leave the account "connected" while every send and sync fails:
  // restart instead (the container comes back with a fresh window, the LinkedIn session is kept).
  const lost = (event: string) => () => {
    logger.error({ event }, 'bridge window lost, exiting so the container restarts');
    process.exit(1);
  };
  page.on('crash', lost('crash'));
  page.on('close', lost('close'));
  shared.bridgeTargetId = await targetIdOf(context, page);
  logger.info({ targetId: shared.bridgeTargetId }, 'bridge window ready');

  const healer = createHealer({
    redis: streams.redis,
    log: { info: (m) => logger.info(m), error: (m) => logger.error(m) },
  });

  const pageLock = createExclusiveRunner('page action');
  const navigate = (p: typeof page, url: string) => pageLock(() => p.goto(url, { waitUntil: 'domcontentloaded' }));

  const ctx: BridgeContext = {
    accountId: config.accountId,
    filesDir: config.filesDir,
    captureRaw: config.captureRaw,
    browser,
    context,
    page,
    streams,
    shared,
    actions: createActions(healer, { fastSend: config.sendMode === 'fast', navigate }),
    state: {
      status: 'AWAITING_LOGIN',
      self: null,
      selfUrn: null,
      collectingConnections: false,
      templates: JSON.parse((await streams.redis.get(`li:tpl:${config.accountId}`)) ?? '{}'),
    },
    exclusive: createExclusiveRunner(),
    pageLock,
  };

  const reader = createReader(ctx);
  await reader.start();
  const session = createSessionMonitor(ctx);
  session.start();
  streams.consume(createCommandHandler(ctx, reader, session.check));
  watchdog(page);
}

/** A check every minute; this many failures in a row = stuck. */
const STUCK_AFTER = 3;

/**
 * A browser can hang without crashing (frozen tab, Chrome not answering): then nothing syncs and nothing sends
 * while the container still looks fine. The bridge window must answer a trivial script within 15 seconds; after
 * three misses in a row the bridge exits, the container restarts, and the app's automatic recovery restarts
 * Chrome too if this doesn't bring the account back.
 */
function watchdog(page: Page) {
  let misses = 0;
  setInterval(async () => {
    try {
      await Promise.race([
        page.evaluate(() => 1),
        new Promise((_, reject) => setTimeout(() => reject(new Error('no answer in 15 s')), 15_000)),
      ]);
      misses = 0;
    } catch (err) {
      misses++;
      logger.warn({ err: (err as Error).message, misses }, 'bridge window did not answer');
      if (misses >= STUCK_AFTER) {
        logger.error('bridge window stuck, exiting so the container restarts');
        process.exit(1);
      }
    }
  }, 60_000).unref();
}
