// Requests made from inside the logged-in LinkedIn page, exactly like LinkedIn's own JavaScript.
import { IDLE_URL } from './actions.ts';
import type { BridgeContext } from './context.ts';
import { extract, profileUrnFrom } from './extract.ts';
import { fillSendBody } from './send-template.ts';

const LINKEDIN = 'https://www.linkedin.com';

async function csrfToken(ctx: BridgeContext) {
  const c = (await ctx.context.cookies(LINKEDIN)).find((k) => k.name === 'JSESSIONID');
  return c?.value?.replace(/"/g, '') ?? '';
}

async function goToLinkedIn(ctx: BridgeContext) {
  if (!ctx.page.url().startsWith(`${LINKEDIN}/`)) await ctx.page.goto(IDLE_URL, { waitUntil: 'domcontentloaded' });
}

export const ensureOnLinkedIn = (ctx: BridgeContext) => ctx.pageLock(() => goToLinkedIn(ctx));

/** A URN as LinkedIn writes it inside a Rest.li variables tuple: parentheses percent-encoded too. */
export const encodeUrn = (urn: string) => encodeURIComponent(urn).replace(/\(/g, '%28').replace(/\)/g, '%29');

/** LinkedIn rejected the request's format (it changed): only then is a learned request worth forgetting. */
export const isFormatRejection = (status: number) => status === 400 || status === 404 || status === 410;

/** Forget a learned request, also in Redis (so a restart doesn't bring it back). */
export function forgetTemplate(ctx: BridgeContext, key: keyof BridgeContext['state']['templates']) {
  delete ctx.state.templates[key];
  ctx.streams.redis.set(`li:tpl:${ctx.accountId}`, JSON.stringify(ctx.state.templates)).catch(() => {});
}

/** A request from inside the bridge page (LinkedIn's cookies, headers and network stack). */
export async function inPageFetch(
  ctx: BridgeContext,
  url: string,
  headers: Record<string, string> = {},
  init: { method?: string; body?: string } = {},
) {
  const token = await csrfToken(ctx);
  return ctx.pageLock(async () => {
    await goToLinkedIn(ctx);
    // A stalled request must not hold the page lock (and with it every send and sync) forever.
    const request = ctx.page.evaluate(
      async ({ url, headers, init, timeoutMs }) => {
        const r = await fetch(url, { ...init, headers, credentials: 'include', signal: AbortSignal.timeout(timeoutMs) });
        return { status: r.status, text: r.ok ? await r.text() : '' };
      },
      { url, headers: { ...headers, 'csrf-token': token }, init, timeoutMs: FETCH_TIMEOUT_MS },
    );
    return withTimeout(request, FETCH_TIMEOUT_MS + 5_000, 'in-page request timed out');
  });
}

const FETCH_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Sends a text message with LinkedIn's own create-message request (learned template), ~one round trip.
 * Null when there is no usable template yet (the caller sends through the UI instead).
 */
export async function sendViaApi(ctx: BridgeContext, conversationUrn: string, text: string) {
  const tpl = ctx.state.templates.send;
  const body = tpl?.body ? fillSendBody(tpl.body, conversationUrn, text) : null;
  if (!tpl || !body) return null;
  return inPageFetch(ctx, tpl.url, tpl.headers, { method: 'POST', body });
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

/**
 * The vanity publicIdentifier for an obfuscated member URN (urn:li:fsd_profile:ACoAA…), via LinkedIn's own
 * profile finder — the one call that bridges a replier (known only by their member URN) to their connection row
 * and to a Twenty Person, both of which key people by the vanity id. Null when LinkedIn doesn't return them.
 */
export async function resolveVanity(ctx: BridgeContext, memberUrn: string): Promise<{ status: number; publicId: string | null }> {
  const obf = memberUrn.replace(/^urn:li:fsd_profile:/, '');
  const r = await inPageFetch(
    ctx,
    `${LINKEDIN}/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(obf)}`,
    {
      accept: 'application/json',
      'x-restli-protocol-version': '2.0.0',
    },
  );
  if (r.status !== 200 || !r.text) return { status: r.status, publicId: null };
  let json: { data?: { elements?: unknown[] }; elements?: unknown[] };
  try {
    json = JSON.parse(r.text);
  } catch {
    return { status: r.status, publicId: null };
  }
  const elements = (json?.data?.elements ?? json?.elements ?? []) as { entityUrn?: string; publicIdentifier?: string }[];
  // Confirm it is the right person: the finder echoes the member URN we asked for in the element's entityUrn.
  const el = elements.find((e) => e?.entityUrn === memberUrn) ?? (elements.length === 1 ? elements[0] : undefined);
  return { status: r.status, publicId: typeof el?.publicIdentifier === 'string' ? el.publicIdentifier : null };
}

export async function hasSessionCookie(ctx: BridgeContext) {
  return (await ctx.context.cookies(LINKEDIN)).some((c) => c.name === 'li_at' && !!c.value);
}

/** The LinkedIn member id (profileId) from a member URN (urn:li:fsd_profile:ACoAA… → ACoAA…). */
export const memberIdOf = (memberUrn: string) => memberUrn.replace(/^urn:li:fsd_profile:/, '');

/**
 * Sends a connection request via LinkedIn's own invitations request. `already` when an invite is already pending or
 * the person is already connected (LinkedIn returns a 4xx for those). NOTE: this endpoint/shape drifts and is NOT
 * verified against a real logged-in account — check it first in a bridge-maintenance pass (docs/bridge-maintenance.md).
 */
export async function sendInvite(
  ctx: BridgeContext,
  memberUrn: string,
  note?: string,
): Promise<{ ok: boolean; already?: boolean; status: number }> {
  const trackingId = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
  const body = JSON.stringify({
    invitee: { 'com.linkedin.voyager.growth.invitation.InviteeProfile': { profileId: memberIdOf(memberUrn) } },
    trackingId,
    ...(note?.trim() ? { message: note.trim().slice(0, 300) } : {}),
  });
  const r = await inPageFetch(
    ctx,
    `${LINKEDIN}/voyager/api/growth/normInvitations`,
    { accept: 'application/json', 'content-type': 'application/json', 'x-restli-protocol-version': '2.0.0' },
    { method: 'POST', body },
  );
  if (r.status === 200 || r.status === 201) return { ok: true, status: r.status };
  // LinkedIn answers 409/422 when an invite already exists or they're already a connection.
  if (r.status === 409 || r.status === 422) return { ok: true, already: true, status: r.status };
  return { ok: false, status: r.status };
}
