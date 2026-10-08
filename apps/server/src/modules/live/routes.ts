import { ACCOUNT_ID_RE } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { accountLevel } from '../../core/access.ts';
import { audit } from '../../core/audit.ts';
import { SESSION_COOKIE, userFromToken } from '../../core/auth.ts';
import { sql } from '../../lib/db.ts';
import { redis } from '../../lib/redis.ts';

/**
 * Live View gate, called by Caddy (forward_auth) before any request reaches an account pod.
 * FULL → can control, REPLY → view only, READ → no access.
 * The account owner can always open it while the account still needs a login.
 */
export default async function liveRoutes(app: FastifyInstance) {
  app.get('/api/live/auth', async (req, reply) => {
    const user = await userFromToken(req.cookies[SESSION_COOKIE]);
    if (!user) return reply.code(401).send('unauthorized');
    const uri = String(req.headers['x-forwarded-uri'] ?? '');
    const accountId = uri.match(/^\/live\/([a-z0-9]{12})(\/|$)/)?.[1];
    if (!accountId || !ACCOUNT_ID_RE.test(accountId)) return reply.code(404).send('not found');

    const level = await accountLevel(user, accountId);
    const [a] = await sql`SELECT owner_user_id, status FROM accounts WHERE id = ${accountId}`;
    if (!a) return reply.code(404).send('not found');
    const ownerLogin = a.ownerUserId === user.id && a.status !== 'CONNECTED';
    const control = level === 'FULL' || ownerLogin;
    if (!control && level !== 'REPLY') return reply.code(403).send('forbidden');

    if (await redis.set(`lu:liveaudit:${user.id}:${accountId}`, '1', 'EX', 1800, 'NX')) {
      await audit({
        userId: user.id,
        accountId,
        action: 'live.opened',
        meta: { control },
        ip: req.ip,
      });
    }
    reply.header('X-LU-User', encodeURIComponent(user.name));
    reply.header('X-LU-Control', control ? '1' : '0');
    return reply.code(200).send('ok');
  });
}
