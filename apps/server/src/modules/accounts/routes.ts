import type { Account, Level } from '@linkedin-console/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleAccountIds, assertAccount } from '../../core/access.ts';
import { audit } from '../../core/audit.ts';
import { requireUser } from '../../core/auth.ts';
import { podSpecOf, pods, sendCommand } from '../../core/bridge.ts';
import { effectiveCapSql, rampDaysLeftSql } from '../../core/send-limits.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { newAccountId } from '../../lib/ids.ts';
import { publish, redis } from '../../lib/redis.ts';

const Timezone = z.string().regex(/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/, 'Invalid timezone');
const Language = z.string().regex(/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/, 'Invalid language');
const ProxyUrl = z
  .string()
  .regex(/^(https?|socks5?):\/\/\S+$/, 'ProxyUrl must look like http://host:port')
  // Chrome can't send SOCKS credentials, and the local forwarder speaks HTTP(S) only.
  .refine((v) => !/^socks5?:\/\/[^/]*@/.test(v), 'SOCKS proxies with a username/password are not supported; use an http(s) proxy')
  .max(300);

export const ACCOUNT_COLUMNS = sql`
  a.id, a.label, a.owner_user_id, a.status, a.profile_urn, a.display_name, a.headline, a.public_id, a.avatar_url,
  a.timezone, a.language, a.send_paused, a.daily_send_cap, a.last_seen_at, a.last_error, a.created_at,
  (a.proxy_server IS NOT NULL AND a.proxy_server <> '') AS has_proxy, a.sync_state AS sync,
  a.new_chat_cap, a.paused_reason, ${effectiveCapSql} AS effective_send_cap, ${rampDaysLeftSql} AS ramp_days_left`;

async function loadAccount(id: string) {
  const [a] = await sql<(Omit<Account, 'level'> & { id: string })[]>`SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = ${id}`;
  return a;
}

export default async function accountRoutes(app: FastifyInstance) {
  app.get('/api/accounts', async (req) => {
    const user = requireUser(req);
    const ids = await accessibleAccountIds(user);
    if (!ids.length) return [];
    // One query (this list is refetched often): the caller's level comes from a join, not a query per account.
    return sql`
      SELECT ${ACCOUNT_COLUMNS}, u.name AS owner_name,
        (SELECT coalesce(sum(unread_count), 0)::int FROM conversations c
         WHERE c.account_id = a.id AND c.unread_count > 0 AND NOT c.is_archived) AS unread,
        ${user.role === 'MEMBER' ? sql`g.level` : sql`'FULL'`} AS level
      FROM accounts a JOIN users u ON u.id = a.owner_user_id
      LEFT JOIN account_grants g ON g.account_id = a.id AND g.user_id = ${user.id}
      WHERE a.id IN ${sql(ids)}
      ORDER BY a.created_at`;
  });

  app.get('/api/accounts/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    const level = await assertAccount(user, id, 'READ');
    return { ...(await loadAccount(id)), level };
  });

  // "Connect LinkedIn account": create the account + its pod; the user then logs in via Live View.
  app.post('/api/accounts', async (req) => {
    const user = requireUser(req);
    const body = z
      .object({
        label: z.string().min(1).max(80),
        timezone: Timezone.default(config.defaultTimezone),
        language: Language.default(config.defaultLanguage),
        proxyServer: ProxyUrl.optional().or(z.literal('')),
      })
      .parse(req.body);
    const id = newAccountId();
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO accounts (id, label, owner_user_id, status, timezone, language, proxy_server, daily_send_cap, new_chat_cap, ramp_started_at)
        VALUES (${id}, ${body.label}, ${user.id}, 'PROVISIONING', ${body.timezone}, ${body.language}, ${body.proxyServer || null},
                ${config.dailySendCap}, ${config.newChatCap}, ${config.sendRamp.on ? sql`now()` : null})`;
      await tx`INSERT INTO account_grants (account_id, user_id, level) VALUES (${id}, ${user.id}, 'FULL')`;
      if (config.defaultGrant !== 'NONE') {
        await tx`
          INSERT INTO account_grants (account_id, user_id, level)
          SELECT ${id}, u.id, ${config.defaultGrant} FROM users u
          WHERE u.id <> ${user.id} AND u.role = 'MEMBER' AND u.disabled_at IS NULL`;
      }
    });
    try {
      await pods.create(id, podSpecOf({ ...body, proxyServer: body.proxyServer || null }));
    } catch (e) {
      await sql`UPDATE accounts SET status = 'ERROR', last_error = ${(e as Error).message} WHERE id = ${id}`;
    }
    await audit({ userId: user.id, accountId: id, action: 'account.created', meta: { label: body.label }, ip: req.ip });
    await publish('admins', 'grants.changed', {});
    return { ...(await loadAccount(id)), level: 'FULL', liveUrl: `/live/${id}/` };
  });

  app.patch('/api/accounts/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await assertAccount(user, id, 'FULL');
    const body = z
      .object({
        label: z.string().min(1).max(80).optional(),
        sendPaused: z.boolean().optional(),
        dailySendCap: z.number().int().min(1).max(500).optional(),
        newChatCap: z.number().int().min(0).max(200).optional(),
        /** An established LinkedIn account: use the full cap from day one. */
        skipRamp: z.literal(true).optional(),
        timezone: Timezone.optional(),
        language: Language.optional(),
        proxyServer: ProxyUrl.optional().or(z.literal('')),
      })
      .parse(req.body);
    const [before] = await sql`SELECT * FROM accounts WHERE id = ${id}`;
    await sql`
      UPDATE accounts SET
        label = ${body.label ?? before.label},
        send_paused = ${body.sendPaused ?? before.sendPaused},
        paused_reason = ${body.sendPaused === false ? null : before.pausedReason},
        daily_send_cap = ${body.dailySendCap ?? before.dailySendCap},
        new_chat_cap = ${body.newChatCap ?? before.newChatCap},
        ramp_started_at = ${body.skipRamp ? null : before.rampStartedAt},
        timezone = ${body.timezone ?? before.timezone},
        language = ${body.language ?? before.language},
        proxy_server = ${body.proxyServer === undefined ? before.proxyServer : body.proxyServer || null}
      WHERE id = ${id}`;
    // Browser identity settings need a new container (the profile/session is kept).
    if (body.timezone || body.language || body.proxyServer !== undefined) {
      const [a] = await sql`SELECT * FROM accounts WHERE id = ${id}`;
      await pods.recreate(id, podSpecOf(a));
    }
    await audit({
      userId: user.id,
      accountId: id,
      action: 'account.updated',
      meta: { ...body, proxyServer: body.proxyServer ? '***' : body.proxyServer },
      ip: req.ip,
    });
    const a = await loadAccount(id);
    await publish(`acc:${id}`, 'account.updated', a);
    return a;
  });

  app.delete('/api/accounts/:id', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await assertAccount(user, id, 'FULL');
    const [a] = await sql`SELECT owner_user_id, label FROM accounts WHERE id = ${id}`;
    if (user.role === 'MEMBER' && a.ownerUserId !== user.id)
      throw new HttpError(403, 'Only the account owner or an admin can disconnect it');
    await pods.remove(id, true).catch((e) => console.error('[accounts] pod remove', e.message));
    await sql`DELETE FROM accounts WHERE id = ${id}`;
    await redis.del(`li:cmd:${id}`, `li:tpl:${id}`, `li:ever:${id}`, `li:bridge-target:${id}`);
    await audit({ userId: user.id, action: 'account.deleted', accountLabel: a.label, meta: { accountId: id }, ip: req.ip, req });
    await publish(`acc:${id}`, 'account.deleted', { id });
    return { ok: true };
  });

  app.post('/api/accounts/:id/restart', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await assertAccount(user, id, 'FULL');
    const [a] = await sql`SELECT * FROM accounts WHERE id = ${id}`;
    const status = await pods.status(id);
    if (status.chrome === 'missing' || status.sidecar === 'missing') await pods.create(id, podSpecOf(a));
    else await pods.restart(id);
    await audit({ userId: user.id, accountId: id, action: 'account.restarted', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/accounts/:id/sync', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await assertAccount(user, id, 'REPLY');
    const { what } = z.object({ what: z.enum(['inbox', 'connections', 'session']).default('inbox') }).parse(req.body ?? {});
    const type = what === 'inbox' ? 'sync_inbox' : what === 'connections' ? 'sync_connections' : 'check_session';
    await sendCommand(id, { type });
    return { ok: true };
  });

  app.get('/api/accounts/:id/grants', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await assertAccount(user, id, 'FULL');
    return sql`
      SELECT u.id AS user_id, u.name, u.role, coalesce(g.level, CASE WHEN u.role <> 'MEMBER' THEN 'FULL' END) AS level
      FROM users u LEFT JOIN account_grants g ON g.user_id = u.id AND g.account_id = ${id}
      WHERE u.disabled_at IS NULL ORDER BY u.created_at`;
  });

  app.put('/api/accounts/:id/grants', async (req) => {
    const user = requireUser(req);
    const { id } = req.params as { id: string };
    await assertAccount(user, id, 'FULL');
    const grants = z.array(z.object({ userId: z.string(), level: z.enum(['READ', 'REPLY', 'FULL']).nullable() })).parse(req.body);
    await sql.begin(async (tx) => {
      for (const g of grants) {
        if (g.level) {
          await tx`
            INSERT INTO account_grants (account_id, user_id, level) VALUES (${id}, ${g.userId}, ${g.level as Level})
            ON CONFLICT (account_id, user_id) DO UPDATE SET level = excluded.level`;
        } else {
          await tx`DELETE FROM account_grants WHERE account_id = ${id} AND user_id = ${g.userId}`;
        }
      }
    });
    await audit({ userId: user.id, accountId: id, action: 'account.grants_changed', meta: { grants }, ip: req.ip });
    for (const g of grants) await publish(`user:${g.userId}`, 'grants.changed', {});
    return { ok: true };
  });
}
