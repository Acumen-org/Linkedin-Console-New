// HEALTH: is this account logged in? Reports AWAITING_LOGIN / CONNECTED / NEEDS_ATTENTION.
import type { BridgeSessionStatus } from '@linkedin-console/contracts';
import { sleep } from '../cdp.ts';
import { logger } from '../logger.ts';
import type { BridgeContext } from './context.ts';
import { ensureOnLinkedIn, hasSessionCookie, inPageFetch, loadSelf } from './linkedin.ts';

const CHALLENGE_RE = /linkedin\.com\/(checkpoint|authwall|uas\/login|login)/;

export function createSessionMonitor(ctx: BridgeContext) {
  const everKey = `li:ever:${ctx.accountId}`;

  async function check(): Promise<BridgeSessionStatus> {
    const { page, context, streams, state } = ctx;
    const loggedIn = await hasSessionCookie(ctx);
    const challenged = context.pages().some((p) => CHALLENGE_RE.test(p.url()));
    const everConnected = (await streams.redis.get(everKey)) === '1';
    let next: BridgeSessionStatus = loggedIn && !challenged ? 'CONNECTED' : everConnected ? 'NEEDS_ATTENTION' : 'AWAITING_LOGIN';

    // Verify with LinkedIn when becoming connected (and now and then), not just the cookie.
    if (next === 'CONNECTED' && (state.status !== 'CONNECTED' || !state.self || Math.random() < 0.1)) {
      const status = await ctx
        .exclusive(async () => {
          await ensureOnLinkedIn(ctx);
          return loadSelf(ctx);
        })
        .catch(() => 0);
      if (status === 401 || status === 403) next = everConnected ? 'NEEDS_ATTENTION' : 'AWAITING_LOGIN';
    }

    const becameConnected = next === 'CONNECTED' && state.status !== 'CONNECTED';
    state.status = next;
    ctx.shared.status = next;
    await streams.emit('session', { status: next, self: state.self });
    if (becameConnected) {
      await streams.redis.set(everKey, '1');
      logger.info({ as: state.self?.name ?? state.selfUrn }, 'connected to LinkedIn');
      ctx.exclusive(() => ctx.actions.loadInbox(page, 6)).catch(() => {});
    }
    return next;
  }

  /** Heartbeat: every ~minute when connected, every 5s while waiting for a login. */
  async function healthLoop() {
    for (;;) {
      try {
        await check();
      } catch (err) {
        logger.warn({ err }, 'session check failed');
      }
      await sleep(ctx.state.status === 'CONNECTED' ? 50_000 + Math.random() * 20_000 : 5_000);
    }
  }

  /** Quietly refresh the conversation list every 6-12 minutes (no thread gets opened). */
  async function reconcileLoop() {
    await sleep(5 * 60_000);
    for (;;) {
      if (ctx.state.status === 'CONNECTED') {
        await ctx
          .exclusive(async () => {
            const tpl = ctx.state.templates.conversations;
            if (tpl) {
              const r = await inPageFetch(ctx, tpl.url, tpl.headers);
              if (r.status !== 200) delete ctx.state.templates.conversations;
            } else {
              await ctx.actions.loadInbox(ctx.page, 1);
            }
          })
          .catch(() => {});
      }
      await sleep(6 * 60_000 + Math.random() * 6 * 60_000);
    }
  }

  return {
    check,
    start() {
      healthLoop();
      reconcileLoop();
    },
  };
}
