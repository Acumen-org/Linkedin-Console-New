// The owner: exactly one (database rule), never demoted or disabled by admins or the staff sync, and the only
// one who may keep password sign-in when everyone else uses Microsoft 365 (PASSWORD_SIGNIN=owner).
import { sql } from '../lib/db.ts';
import { HttpError } from '../lib/errors.ts';
import { publish } from '../lib/redis.ts';
import { audit } from './audit.ts';

/**
 * Hands ownership to an active teammate; the previous owner stays on as an admin. `by` is null when done on
 * the server (scripts/set-owner.sh), recorded as System.
 */
export async function transferOwnership(toUserId: string, by: { id: string } | null, ip?: string) {
  const previous = await sql.begin(async (tx) => {
    const [target] = await tx`SELECT id, role, disabled_at FROM users WHERE id = ${toUserId} FOR UPDATE`;
    if (!target) throw new HttpError(404, 'User not found');
    if (target.disabledAt) throw new HttpError(409, 'Enable this teammate first');
    if (target.role === 'OWNER') return null;
    const [old] = await tx`UPDATE users SET role = 'ADMIN' WHERE role = 'OWNER' RETURNING id`;
    await tx`UPDATE users SET role = 'OWNER' WHERE id = ${toUserId}`;
    // Owners and admins see every account through their role; grants and the auditor's limits don't apply.
    await tx`DELETE FROM account_grants WHERE user_id = ${toUserId}`;
    return { id: (old?.id as string | undefined) ?? null };
  });
  if (!previous) return { changed: false };
  for (const id of [toUserId, previous.id]) if (id) await publish(`user:${id}`, 'grants.changed', {});
  await audit({
    userId: by?.id ?? null,
    action: 'user.owner_transferred',
    meta: { targetUserId: toUserId, previousOwnerId: previous.id },
    ip,
  });
  return { changed: true, previousOwnerId: previous.id };
}
