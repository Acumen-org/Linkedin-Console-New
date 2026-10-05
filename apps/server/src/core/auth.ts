import crypto from 'node:crypto';
import type { Role } from '@linkunify/contracts';
import { hash, verify } from '@node-rs/argon2';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { HttpError } from '../lib/errors.ts';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

export const SESSION_COOKIE = 'lu_session';
const SESSION_DAYS = 30;

export const hashPassword = (pw: string) => hash(pw);
export const verifyPassword = (stored: string, pw: string) => verify(stored, pw).catch(() => false);

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(reply: FastifyReply, req: FastifyRequest, userId: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  await sql`
    INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
    VALUES (${sha256(token)}, ${userId}, now() + ${`${SESSION_DAYS} days`}::interval, ${req.ip},
            ${String(req.headers['user-agent'] ?? '').slice(0, 300)})`;
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function destroySession(reply: FastifyReply, token: string | undefined) {
  if (token) await sql`DELETE FROM sessions WHERE id = ${sha256(token)}`;
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function userFromToken(token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const [u] = await sql<SessionUser[]>`
    SELECT u.id, u.email, u.name, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sha256(token)} AND s.expires_at > now() AND u.disabled_at IS NULL`;
  return u ?? null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function requireUser(req: FastifyRequest): SessionUser {
  if (!req.user) throw new HttpError(401, 'Not logged in');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): SessionUser {
  const u = requireUser(req);
  if (u.role === 'MEMBER') throw new HttpError(403, 'Admins only');
  return u;
}

/**
 * In-memory brute-force protection: 10 failed logins per IP per 15 minutes.
 * Only failures count, so a whole office behind one IP isn't locked out by normal use.
 */
const failures = new Map<string, { n: number; until: number }>();

export function assertLoginAllowed(ip: string) {
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.n >= 10) throw new HttpError(429, 'Too many failed login attempts, try again later');
}

export function recordLoginFailure(ip: string) {
  const now = Date.now();
  const f = failures.get(ip);
  if (!f || f.until < now) failures.set(ip, { n: 1, until: now + 15 * 60_000 });
  else f.n++;
}

export const clearLoginFailures = (ip: string) => failures.delete(ip);
