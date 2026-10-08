// Microsoft 365 sign-in (OpenID Connect, authorization code + PKCE) against the company's Entra tenant,
// the same identity the Twilio console uses. Only existing, enabled teammates can sign in: the account
// is matched by its Entra object ID once linked, and by email the first time. MFA and conditional
// access are enforced by Microsoft.
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../../core/audit.ts';
import { assertLoginAllowed, clearLoginFailures, createSession, recordLoginFailure } from '../../core/auth.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { logger } from '../../lib/logger.ts';
import { redis } from '../../lib/redis.ts';

const STATE_COOKIE = 'lu_oidc';
const CALLBACK_PATH = '/api/auth/microsoft/callback';
const b64url = (b: Buffer) => b.toString('base64url');

interface IdClaims {
  iss?: string;
  aud?: string;
  tid?: string;
  oid?: string;
  exp?: number;
  nonce?: string;
  email?: string;
  preferred_username?: string;
  name?: string;
}

/** The ID token comes straight from Microsoft's token endpoint over TLS (OIDC Core 3.1.3.7): check its claims. */
export function claimsFromIdToken(idToken: string, expect: { tenantId: string; clientId: string; nonce: string }): IdClaims {
  const payload = idToken.split('.')[1];
  if (!payload) throw new Error('malformed ID token');
  const c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IdClaims;
  if (c.iss !== `https://login.microsoftonline.com/${expect.tenantId}/v2.0`) throw new Error('wrong issuer');
  if (c.tid !== expect.tenantId) throw new Error('wrong tenant');
  if (c.aud !== expect.clientId) throw new Error('wrong audience');
  if (!c.exp || c.exp * 1000 < Date.now() - 60_000) throw new Error('expired');
  if (!c.nonce || c.nonce !== expect.nonce) throw new Error('wrong nonce');
  if (!c.oid) throw new Error('no object id');
  return c;
}

const toLogin = (reply: FastifyReply, error: string) => reply.redirect(`/login?error=${encodeURIComponent(error)}`);

export default async function microsoftRoutes(app: FastifyInstance) {
  app.get('/api/auth/methods', async () => ({ microsoft: !!config.microsoft, password: config.passwordSignin }));

  const ms = config.microsoft;
  if (!ms) return;
  const authority = `https://login.microsoftonline.com/${ms.tenantId}/oauth2/v2.0`;
  const redirectUri = `${config.appUrl}${CALLBACK_PATH}`;

  app.get('/api/auth/microsoft', async (_req, reply) => {
    const state = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const verifier = b64url(crypto.randomBytes(32));
    await redis.set(`lu:oidc:${state}`, JSON.stringify({ nonce, verifier }), 'EX', 600);
    // Binds the sign-in to this browser (no one can finish a sign-in they started for someone else).
    reply.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      path: CALLBACK_PATH,
      maxAge: 600,
    });
    const params = new URLSearchParams({
      client_id: ms.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      response_mode: 'query',
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return reply.redirect(`${authority}/authorize?${params}`);
  });

  app.get(CALLBACK_PATH, async (req: FastifyRequest<{ Querystring: Record<string, string> }>, reply) => {
    const { code, state, error } = req.query;
    reply.clearCookie(STATE_COOKIE, { path: CALLBACK_PATH });
    if (error) return toLogin(reply, error === 'access_denied' ? 'Sign-in was cancelled' : 'Microsoft sign-in failed');
    try {
      assertLoginAllowed(req.ip);
    } catch {
      return toLogin(reply, 'Too many failed sign-ins, try again later');
    }
    const saved = state && state === req.cookies[STATE_COOKIE] ? await redis.getdel(`lu:oidc:${state}`) : null;
    if (!code || !saved) return toLogin(reply, 'The sign-in expired, please try again');
    const { nonce, verifier } = JSON.parse(saved) as { nonce: string; verifier: string };

    let claims: IdClaims;
    try {
      const res = await fetch(`${authority}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: ms.clientId,
          client_secret: ms.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          scope: 'openid profile email',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json()) as { id_token?: string; error?: string; error_description?: string };
      if (!res.ok || !body.id_token) throw new Error(body.error_description ?? body.error ?? `token endpoint ${res.status}`);
      claims = claimsFromIdToken(body.id_token, { tenantId: ms.tenantId, clientId: ms.clientId, nonce });
    } catch (err) {
      logger.warn({ err }, 'Microsoft sign-in failed');
      return toLogin(reply, 'Microsoft sign-in failed');
    }

    const email = (claims.email ?? claims.preferred_username ?? '').toLowerCase().trim();
    // Linked accounts are matched by the Entra object ID; the first time, by email (and then linked).
    const [byOid] = await sql`SELECT id, disabled_at FROM users WHERE microsoft_oid = ${claims.oid!}`;
    const [byEmail] = byOid ? [] : await sql`SELECT id, disabled_at, microsoft_oid FROM users WHERE email = ${email}`;
    const user = byOid ?? (byEmail && !byEmail.microsoftOid ? byEmail : null);
    if (!user || user.disabledAt) {
      recordLoginFailure(req.ip);
      const reason = !user ? (byEmail ? 'email linked to another Microsoft account' : 'not a teammate') : 'account disabled';
      await audit({ userId: user?.id ?? null, action: 'auth.login_failed', meta: { method: 'microsoft', email, reason }, ip: req.ip, req });
      return toLogin(
        reply,
        user ? 'Your access has been disabled' : `${email || 'This account'} is not a member of this workspace. Ask an admin to add you.`,
      );
    }
    if (!byOid) await sql`UPDATE users SET microsoft_oid = ${claims.oid!} WHERE id = ${user.id}`;
    clearLoginFailures(req.ip);
    await createSession(reply, req, user.id, 'microsoft');
    await audit({ userId: user.id, action: 'auth.login', meta: { method: 'microsoft' }, ip: req.ip, req });
    return reply.redirect('/');
  });
}
