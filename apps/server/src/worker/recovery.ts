// Account browsers never stay off: every minute, an account whose browser stopped reporting (OFFLINE/ERROR), or
// whose containers are missing or not running, is restarted (created again if gone; the LinkedIn session lives
// in the profile volume and is kept). Retried with growing pauses; admins are alerted only when the restarts
// don't bring it back. A browser that reports again resets all of this (see onSession).
// What this can't fix: LinkedIn logging the account out (NEEDS_ATTENTION) needs a person to log in again.
import { ADMINS_ROOM, accountRoom } from '@linkedin-console/contracts';
import { audit } from '../core/audit.ts';
import { type PodStatus, pods as podAgent, podSpecOf } from '../core/bridge.ts';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { publish, redis } from '../lib/redis.ts';
import { alertAccountStatus } from './alerts.ts';

/** Minutes until the next try, after the n-th restart (then hourly). */
const PAUSE_MIN = [2, 5, 15, 30, 60];
/** Restarts before the admins are told (about 20 minutes of trying). */
const ALERT_AFTER = 3;
/** A just-created account gets this long before a missing pod counts as a problem. */
const GRACE_MIN = 3;

type Pods = Pick<typeof podAgent, 'list' | 'create' | 'restart'>;

async function restart(pods: Pods, a: Record<string, any>, pod: PodStatus | undefined, reason: string) {
  // Deleted meanwhile: nothing to bring back.
  const [still] = await sql`SELECT 1 FROM accounts WHERE id = ${a.id}`;
  if (!still) return;
  const attempt = (a.recoverAttempts as number) + 1;
  let error: string | null = null;
  try {
    if (!pod || pod.chrome === 'missing' || pod.sidecar === 'missing') await pods.create(a.id, podSpecOf(a));
    else await pods.restart(a.id);
  } catch (err) {
    error = (err as Error).message;
    logger.warn({ err, accountId: a.id }, 'automatic restart failed');
  }
  const pause = PAUSE_MIN[Math.min(attempt, PAUSE_MIN.length) - 1];
  const [updated] = await sql`
    UPDATE accounts SET
      -- Shown as starting; back to OFFLINE if it doesn't report within a few minutes (detectOfflinePods).
      status = CASE WHEN status IN ('OFFLINE', 'ERROR') THEN 'PROVISIONING' ELSE status END,
      last_seen_at = CASE WHEN status IN ('OFFLINE', 'ERROR') THEN now() ELSE last_seen_at END,
      recover_attempts = ${attempt}, recover_next_at = now() + make_interval(mins => ${pause}),
      last_restart_at = now(), last_restart_reason = ${reason}, last_error = ${error}
    WHERE id = ${a.id}
    RETURNING id, status, last_restart_at, last_restart_reason, recover_attempts`;
  await audit({ accountId: a.id, action: 'account.auto_restarted', meta: { reason, attempt, error } });
  await publish([accountRoom(a.id), ADMINS_ROOM], 'account.updated', updated as never);
  if (attempt === ALERT_AFTER) await alertAccountStatus(a.id, 'OFFLINE');
}

/** `pods` replaces the pod-agent in tests (no real browsers there). Off with AUTO_RECOVERY=off. */
export async function recoverAccounts(opts: { pods?: Pods } = {}) {
  if (!opts.pods && !config.autoRecovery) return;
  const pods = opts.pods ?? podAgent;
  if (!(await redis.set('lu:recovery:lock', '1', 'EX', 300, 'NX'))) return;
  try {
    const list = await pods.list().catch((err) => {
      logger.warn({ err }, 'pod-agent unreachable; only accounts already offline are retried');
      return null;
    });
    const byId = new Map((list ?? []).map((p) => [p.id, p]));
    const accounts = await sql`
      SELECT * FROM accounts
      WHERE recover_next_at IS NULL OR recover_next_at <= now()`;
    for (const a of accounts) {
      const pod = byId.get(a.id);
      const down = a.status === 'OFFLINE' || a.status === 'ERROR';
      const young = Date.now() - new Date(a.createdAt).getTime() < GRACE_MIN * 60_000;
      // Containers gone or stopped (pod-agent answered): restart now, whatever the status says.
      const stopped = list !== null && !young && (!pod || !pod.running);
      if (!down && !stopped) continue;
      const reason = stopped
        ? !pod || pod.chrome === 'missing' || pod.sidecar === 'missing'
          ? 'Browser containers were missing'
          : 'Browser containers were stopped'
        : 'Browser stopped reporting';
      await restart(pods, a, pod, reason);
    }
  } finally {
    await redis.del('lu:recovery:lock');
  }
}
