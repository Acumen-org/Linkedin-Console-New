import type { Redis } from 'ioredis';
import type { Browser, BrowserContext, Page } from 'patchright';

export async function targetIdOf(context: BrowserContext, page: Page): Promise<string> {
  const s = await context.newCDPSession(page);
  const { targetInfo } = (await s.send('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
  await s.detach().catch(() => {});
  return targetInfo.targetId;
}

/** The bridge works in its own background window, reused across sidecar restarts. */
export async function openBridgeWindow(browser: Browser, context: BrowserContext, redis: Redis, accountId: string): Promise<Page> {
  const key = `li:bridge-target:${accountId}`;
  const savedId = await redis.get(key);
  if (savedId) {
    for (const p of context.pages()) {
      if ((await targetIdOf(context, p).catch(() => null)) === savedId) return p;
    }
  }
  const pagePromise = context.waitForEvent('page', { timeout: 60_000 });
  const session = await browser.newBrowserCDPSession();
  await session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
  const page = await pagePromise;
  await redis.set(key, await targetIdOf(context, page));
  return page;
}
