// Proxy pool admin API (Settings → Proxies). Everything here is admin-only and refused with 409 while the pool switch
// is off (config.multiProxy). Credentials are never returned (core/proxies maskAddress) and never written to the audit
// log. Changing a proxy's address restarts the browsers of the accounts on it, keeping their LinkedIn session.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit.ts';
import { requireAdmin } from '../../core/auth.ts';
import { podSpecOf, pods } from '../../core/bridge.ts';
import { createProxy, deleteProxy, listProxies, updateProxy } from '../../core/proxies.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { checkProxy, ProxyAddress } from '../../lib/proxy-check.ts';

/** The pool must be switched on for any of these to work. */
function requirePool() {
  if (!config.multiProxy) throw new HttpError(409, 'The proxy pool is off (turn it on in Settings → Integrations)');
}

export default async function proxyRoutes(app: FastifyInstance) {
  app.get('/api/proxies', async (req) => {
    requireAdmin(req);
    requirePool();
    return listProxies();
  });

  app.post('/api/proxies', async (req) => {
    const admin = requireAdmin(req);
    requirePool();
    const body = z
      .object({ label: z.string().trim().min(1).max(80), address: ProxyAddress, maxAccounts: z.number().int().min(1).max(50).default(1) })
      .parse(req.body);
    const proxy = await createProxy(body);
    await audit({
      userId: admin.id,
      action: 'proxy.created',
      meta: { id: proxy.id, label: proxy.label, maxAccounts: proxy.maxAccounts },
      ip: req.ip,
    });
    return proxy;
  });

  app.patch<{ Params: { id: string } }>('/api/proxies/:id', async (req) => {
    const admin = requireAdmin(req);
    requirePool();
    const body = z
      .object({
        label: z.string().trim().min(1).max(80).optional(),
        address: ProxyAddress.optional(),
        maxAccounts: z.number().int().min(1).max(50).optional(),
        disabled: z.boolean().optional(),
      })
      .parse(req.body);
    const { view, restartedAccountIds } = await updateProxy(req.params.id, body);
    // A changed address is already copied into each pinned account; restart those browsers so they pick it up.
    for (const accountId of restartedAccountIds) {
      const [a] = await sql`SELECT * FROM accounts WHERE id = ${accountId}`;
      if (a)
        await pods
          .recreate(accountId, podSpecOf(a))
          .catch((e) => req.log.error({ err: e, accountId }, 'proxy change: pod recreate failed'));
    }
    await audit({
      userId: admin.id,
      action: 'proxy.updated',
      // Record what changed, never the address itself.
      meta: {
        id: view.id,
        changed: Object.keys(body),
        addressChanged: restartedAccountIds.length > 0,
        restarted: restartedAccountIds.length,
      },
      ip: req.ip,
    });
    return view;
  });

  app.delete<{ Params: { id: string } }>('/api/proxies/:id', async (req) => {
    const admin = requireAdmin(req);
    requirePool();
    await deleteProxy(req.params.id);
    await audit({ userId: admin.id, action: 'proxy.deleted', meta: { id: req.params.id }, ip: req.ip });
    return { ok: true };
  });

  // Can the proxy open a tunnel to LinkedIn? Nothing is sent through it. Proves it answers, not that LinkedIn accepts it.
  app.post<{ Params: { id: string } }>('/api/proxies/:id/test', async (req) => {
    requireAdmin(req);
    requirePool();
    const [p] = await sql<{ address: string }[]>`SELECT address FROM proxies WHERE id = ${req.params.id}`;
    if (!p) throw new HttpError(404, 'Proxy not found');
    return checkProxy(p.address);
  });
}
