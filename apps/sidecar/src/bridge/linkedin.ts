// Requests made from inside the logged-in LinkedIn page, exactly like LinkedIn's own JavaScript.
import { IDLE_URL } from './actions.ts';
import type { BridgeContext } from './context.ts';
import { extract, profileUrnFrom } from './extract.ts';

const LINKEDIN = 'https://www.linkedin.com';

async function csrfToken(ctx: BridgeContext) {
  const c = (await ctx.context.cookies(LINKEDIN)).find((k) => k.name === 'JSESSIONID');
  return c?.value?.replace(/"/g, '') ?? '';
}

export async function ensureOnLinkedIn(ctx: BridgeContext) {
  if (!ctx.page.url().startsWith(`${LINKEDIN}/`)) await ctx.page.goto(IDLE_URL, { waitUntil: 'domcontentloaded' });
}

export async function inPageFetch(ctx: BridgeContext, url: string, headers: Record<string, string> = {}) {
  await ensureOnLinkedIn(ctx);
  const token = await csrfToken(ctx);
  return ctx.page.evaluate(
    async ({ url, headers }) => {
      const r = await fetch(url, { headers, credentials: 'include' });
      return { status: r.status, text: r.status === 200 ? await r.text() : '' };
    },
    { url, headers: { ...headers, 'csrf-token': token } },
  );
}

async function voyager(ctx: BridgeContext, pathAndQuery: string) {
  const r = await inPageFetch(ctx, `${LINKEDIN}/voyager/api${pathAndQuery}`, {
    accept: 'application/vnd.linkedin.normalized+json+2.1',
    'x-restli-protocol-version': '2.0.0',
  });
  return { status: r.status, json: r.text ? JSON.parse(r.text) : null };
}

/** Who is logged in (stores it in ctx.state). Returns the HTTP status. */
export async function loadSelf(ctx: BridgeContext): Promise<number> {
  const { status, json } = await voyager(ctx, '/me');
  if (status !== 200 || !json) return status;
  const p = extract(json).profiles[0];
  const urn = p?.urn ?? profileUrnFrom(JSON.stringify(json));
  if (urn) {
    ctx.state.selfUrn = urn;
    ctx.state.self = {
      urn,
      name: p?.name ?? null,
      publicId: p?.publicId ?? null,
      headline: p?.headline ?? null,
      avatarUrl: p?.avatarUrl ?? null,
    };
  }
  return status;
}

export async function hasSessionCookie(ctx: BridgeContext) {
  return (await ctx.context.cookies(LINKEDIN)).some((c) => c.name === 'li_at' && !!c.value);
}
