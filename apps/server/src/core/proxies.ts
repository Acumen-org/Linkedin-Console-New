// Proxy pool data + rules. A proxy is registered once by an admin; accounts are pinned to one and never rotated. The
// chosen proxy's address is copied into accounts.proxy_server (done by pinProxy / updateProxy), so the browser path is
// the single source of truth and an account that is not in the pool is untouched. Credentials are never returned by the
// API (maskAddress) and never written to the audit log.
import type { TransactionSql } from 'postgres';
import { sql } from '../lib/db.ts';
import { HttpError } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { maskAddress } from '../lib/proxy-check.ts';

export interface ProxyView {
  id: string;
  label: string;
  /** Masked: scheme://host:port only — credentials are never returned. */
  address: string;
  maxAccounts: number;
  disabled: boolean;
  /** Accounts currently pinned to this proxy. */
  inUse: number;
  createdAt: string;
}

interface ProxyRow {
  id: string;
  label: string;
  address: string;
  maxAccounts: number;
  disabledAt: Date | null;
  createdAt: string;
  inUse?: number;
}

const toView = (r: ProxyRow): ProxyView => ({
  id: r.id,
  label: r.label,
  address: maskAddress(r.address),
  maxAccounts: r.maxAccounts,
  disabled: !!r.disabledAt,
  inUse: r.inUse ?? 0,
  createdAt: r.createdAt,
});

export async function listProxies(): Promise<ProxyView[]> {
  const rows = await sql<ProxyRow[]>`
    SELECT p.*, (SELECT count(*)::int FROM accounts a WHERE a.proxy_id = p.id) AS in_use
    FROM proxies p ORDER BY p.created_at`;
  return rows.map(toView);
}

export async function createProxy(input: { label: string; address: string; maxAccounts: number }): Promise<ProxyView> {
  const id = newId('px');
  const [row] = await sql<ProxyRow[]>`
    INSERT INTO proxies (id, label, address, max_accounts)
    VALUES (${id}, ${input.label}, ${input.address}, ${input.maxAccounts})
    RETURNING *, 0 AS in_use`;
  return toView(row);
}

/** Edit a proxy. If the address changes, the new address is copied into every pinned account's proxy_server and their
 *  ids are returned so the route can restart those browsers (the LinkedIn session is kept). */
export async function updateProxy(
  id: string,
  input: { label?: string; address?: string; maxAccounts?: number; disabled?: boolean },
): Promise<{ view: ProxyView; restartedAccountIds: string[] }> {
  return sql.begin(async (tx) => {
    const [p] = await tx<ProxyRow[]>`SELECT * FROM proxies WHERE id = ${id} FOR UPDATE`;
    if (!p) throw new HttpError(404, 'Proxy not found');

    if (input.maxAccounts !== undefined) {
      const [{ count }] = await tx<{ count: number }[]>`SELECT count(*)::int FROM accounts WHERE proxy_id = ${id}`;
      if (input.maxAccounts < count)
        throw new HttpError(409, `This proxy already has ${count} account(s); move some off before lowering the limit`);
    }

    const disabledAt = input.disabled === undefined ? p.disabledAt : input.disabled ? new Date() : null;
    await tx`
      UPDATE proxies SET
        label = ${input.label ?? p.label},
        address = ${input.address ?? p.address},
        max_accounts = ${input.maxAccounts ?? p.maxAccounts},
        disabled_at = ${disabledAt}
      WHERE id = ${id}`;

    let restartedAccountIds: string[] = [];
    if (input.address !== undefined && input.address !== p.address) {
      const newAddress = input.address;
      const rows = await tx<{ id: string }[]>`UPDATE accounts SET proxy_server = ${newAddress} WHERE proxy_id = ${id} RETURNING id`;
      restartedAccountIds = rows.map((r) => r.id);
    }

    const [row] = await tx<ProxyRow[]>`
      SELECT p.*, (SELECT count(*)::int FROM accounts a WHERE a.proxy_id = p.id) AS in_use FROM proxies p WHERE p.id = ${id}`;
    return { view: toView(row), restartedAccountIds };
  });
}

/** Remove a proxy — only when no account uses it. */
export async function deleteProxy(id: string): Promise<void> {
  await sql.begin(async (tx) => {
    const [p] = await tx<{ id: string }[]>`SELECT id FROM proxies WHERE id = ${id} FOR UPDATE`;
    if (!p) throw new HttpError(404, 'Proxy not found');
    const [{ count }] = await tx<{ count: number }[]>`SELECT count(*)::int FROM accounts WHERE proxy_id = ${id}`;
    if (count > 0) throw new HttpError(409, `This proxy is used by ${count} account(s); move them off it first`);
    await tx`DELETE FROM proxies WHERE id = ${id}`;
  });
}

/** Resolve a pin inside the caller's transaction: lock the proxy row, check it is usable and has a free slot, and
 *  return the address to copy into the account. The lock + capacity check + the account write happen in one
 *  transaction, so two accounts cannot take the last place. */
export async function pinProxy(tx: TransactionSql, proxyId: string, excludeAccountId: string): Promise<{ address: string }> {
  const [p] = await tx<ProxyRow[]>`SELECT * FROM proxies WHERE id = ${proxyId} FOR UPDATE`;
  if (!p) throw new HttpError(404, 'Proxy not found');
  if (p.disabledAt) throw new HttpError(409, 'That proxy is disabled; pick another');
  const [{ count }] = await tx<{ count: number }[]>`
    SELECT count(*)::int FROM accounts WHERE proxy_id = ${proxyId} AND id <> ${excludeAccountId}`;
  if (count >= p.maxAccounts) throw new HttpError(409, 'That proxy is at capacity; pick another or raise its limit');
  return { address: p.address };
}
