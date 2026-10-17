// Backfill every conversation's messages back to its first one, by driving each account's browser to replay
// LinkedIn's own "load older" request (see the sidecar's backfill_thread). Gentle and health-gated: only
// connected accounts with no recent LinkedIn warning, a few threads at a time, and the pace grows with how long
// the account has been connected here (a new account goes slowly, an established one faster). Resumable: the
// paging cursor is just the oldest message already stored, and a thread is marked done when its start is reached.
import { sendCommand } from '../core/bridge.ts';
import { sql } from '../lib/db.ts';
import { redis } from '../lib/redis.ts';

/** Let a new account settle (first sync, ramp) before deep-backfilling. */
const GRACE_DAYS = 1;
const MAX_THREADS_PER_RUN = 6;
const MAX_PAGES = 10;

export async function backfillHistory() {
  const accounts = await sql<{ id: string; level: number }[]>`
    SELECT id, CASE WHEN ramp_started_at IS NULL THEN 30 ELSE ramp_level END AS level
    FROM accounts
    WHERE status = 'CONNECTED' AND NOT send_paused AND paused_reason IS NULL
      AND created_at < now() - make_interval(days => ${GRACE_DAYS})`;
  for (const a of accounts) {
    // Pace grows with the account's warm-up level (healthy days ramped), the same one that paces the send cap:
    // more threads per batch, shorter cooldown, deeper per command. A finished ramp (level 30) runs at full rate.
    const level = Number(a.level);
    const threadsPerRun = Math.max(1, Math.min(MAX_THREADS_PER_RUN, 1 + Math.floor(level / 3)));
    const cooldownSec = Math.max(30, Math.min(180, Math.round(180 - level * 10)));
    const maxPages = Math.max(2, Math.min(MAX_PAGES, 2 + Math.floor(level / 7)));
    // One batch per account per cooldown (gentle; the cooldown shrinks as the account gets older).
    if (!(await redis.set(`lu:backfill:${a.id}`, '1', 'EX', cooldownSec, 'NX'))) continue;
    const convos = await sql<{ threadUrn: string; threadId: string | null; oldestMs: number | null }[]>`
      SELECT c.thread_urn, c.thread_id,
             (SELECT extract(epoch FROM min(m.sent_at)) * 1000 FROM messages m WHERE m.conversation_id = c.id) AS oldest_ms
      FROM conversations c
      WHERE c.account_id = ${a.id} AND c.history_backfilled_at IS NULL AND c.thread_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)
      -- Read chats first: the one-time priming open (to learn LinkedIn's "load older" request) never marks an unread chat read.
      ORDER BY c.unread_count ASC, c.last_message_at DESC NULLS LAST
      LIMIT ${threadsPerRun}`;
    for (const c of convos) {
      await sendCommand(a.id, {
        type: 'backfill_thread',
        conversationUrn: c.threadUrn,
        threadId: c.threadId,
        beforeMs: c.oldestMs == null ? null : Math.floor(Number(c.oldestMs)),
        maxPages,
      });
    }
  }
}
