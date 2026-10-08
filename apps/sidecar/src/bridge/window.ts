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
  // Match the new page by its target id: a page someone opens in Live View at the same moment would
  // otherwise be taken for the bridge window.
  const session = await browser.newBrowserCDPSession();
  const { targetId } = (await session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true })) as {
    targetId: string;
  };
  await session.detach().catch(() => {});
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if ((await targetIdOf(context, p).catch(() => null)) === targetId) {
        await redis.set(key, targetId);
        return p;
      }
    }
    await context.waitForEvent('page', { timeout: 1_000 }).catch(() => {});
  }
  throw new Error('The bridge window did not open');
}
