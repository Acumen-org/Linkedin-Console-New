// First sync of a newly connected account, so it looks complete right away instead of filling up only as new
// messages arrive:
//   1. the 100 most recent conversations (about a minute), plus the newest connections (quick pass)
//   2. recent history of each of those, newest first, at a calm pace (about 5 minutes); a conversation
//      someone opens jumps the queue
//   3. then the full connection list in the background, with progress and a time estimate
// Progress is stored on the account (sync_state) and pushed to the team.
import { type AccountSync, ADMINS_ROOM, accountRoom, type BridgeEventMap } from '@linkedin-console/contracts';
import { sendCommand } from '../core/bridge.ts';
import { sql } from '../lib/db.ts';
import { publish, redis } from '../lib/redis.ts';

export const FIRST_SYNC_CONVERSATIONS = 100;
const QUICK_CONNECTION_SCROLLS = 6; // about the newest 100
const FULL_CONNECTION_SCROLLS = 400;

type SyncState = AccountSync & {
  fullConnectionsRequested?: boolean;
  /** The full connection sync's command: only its result completes the list (not the quick pass). */
  fullConnectionsCmdId?: string;
  connectionsStartedAt?: string | null;
};

/**
 * Starts the first sync once per account. Returns false when it already ran: a reconnect catches up instead
 * (catchUp), and someone with full access can run the whole sync again (restartFirstSync).
 */
export async function startFirstSync(accountId: string): Promise<boolean> {
  const state: SyncState = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    conversations: { loaded: 0, target: FIRST_SYNC_CONVERSATIONS, done: false },
    history: { done: 0, total: 0 },
    connections: { loaded: 0, total: null, done: false, etaMinutes: null },
  };
  const [started] = await sql`
    UPDATE accounts SET sync_state = ${sql.json(state as never)} WHERE id = ${accountId} AND sync_state IS NULL RETURNING id`;
  if (!started) return false;
  await sendCommand(accountId, { type: 'sync_inbox', target: FIRST_SYNC_CONVERSATIONS });
  await sendCommand(accountId, { type: 'sync_connections', maxScrolls: QUICK_CONNECTION_SCROLLS, progress: true });
  await publishState(accountId);
  return true;
}

/** A first sync that is still running (an older one that never finished doesn't block a new one). */
export async function firstSyncRunning(accountId: string) {
  const state = await load(accountId);
  return !!state && !state.finishedAt && Date.now() - Date.parse(state.startedAt) < 6 * 3600_000;
}

/**
 * Runs the whole first sync again: every conversation's history counts as not loaded (chats load theirs as
 * they come up in the list, or when someone opens them), then 100 recent chats, their history, connections.
 */
export async function restartFirstSync(accountId: string) {
  await sql`UPDATE conversations SET history_requested_at = NULL, history_synced_at = NULL WHERE account_id = ${accountId}`;
  await sql`UPDATE accounts SET sync_state = NULL WHERE id = ${accountId}`;
  await redis.del(catchUpKey(accountId));
  return startFirstSync(accountId);
}

const catchUpKey = (accountId: string) => `lu:catchup:${accountId}`;
const CATCH_UP_MINUTES = 30;

/**
 * The account is back after being offline (logged out, browser restarted): messages that came in meanwhile
 * were never seen. Reload the recent chats; the ones with activity since the newest message we have get their
 * history fetched again (see needsCatchUp).
 */
export async function catchUp(accountId: string) {
  const [c] = await sql`SELECT max(last_message_at) AS newest FROM conversations WHERE account_id = ${accountId}`;
  const since = (c?.newest as Date | null)?.getTime() ?? 0;
  await redis.set(catchUpKey(accountId), JSON.stringify({ since, at: Date.now() }), 'EX', CATCH_UP_MINUTES * 60);
  await sendCommand(accountId, { type: 'sync_inbox', target: FIRST_SYNC_CONVERSATIONS });
}

export type CatchUpWindow = { since: number; at: number } | null;

export async function catchUpWindow(accountId: string): Promise<CatchUpWindow> {
  const raw = await redis.get(catchUpKey(accountId));
  return raw ? JSON.parse(raw) : null;
}

/** During a catch-up: this chat had activity while we were away and its history hasn't been fetched since. */
export function missedWhileAway(
  w: CatchUpWindow,
  lastActivityAt: number | null,
  row: { historyRequestedAt: Date | null; historySyncedAt: Date | null },
) {
  if (!w || !lastActivityAt || lastActivityAt <= w.since) return false;
  const fetchedAt = Math.max(row.historyRequestedAt?.getTime() ?? 0, row.historySyncedAt?.getTime() ?? 0);
  return fetchedAt < w.at;
}

async function load(accountId: string): Promise<SyncState | null> {
  const [a] = await sql`SELECT sync_state FROM accounts WHERE id = ${accountId}`;
  return (a?.syncState as SyncState | null) ?? null;
}

/**
 * Read-modify-write of the sync state with the account row locked: progress (events stream) and results
 * (results stream) arrive in parallel and must not overwrite each other. `change` returns false to skip.
 */
async function mutate(accountId: string, change: (state: SyncState) => unknown) {
  const changed = await sql.begin(async (tx) => {
    const [a] = await tx`SELECT sync_state FROM accounts WHERE id = ${accountId} FOR UPDATE`;
    const state = a?.syncState as SyncState | null;
    if (!state || state.finishedAt) return false;
    if ((await change(state)) === false) return false;
    await tx`UPDATE accounts SET sync_state = ${sql.json(state as never)} WHERE id = ${accountId}`;
    return true;
  });
  if (changed) await publishState(accountId);
}

async function publishState(accountId: string) {
  const state = await load(accountId);
  await publish([accountRoom(accountId), ADMINS_ROOM], 'account.updated', { id: accountId, sync: state });
}

/**
 * Recounts progress from the database (no drifting counters), finishes the sync when everything is in, and
 * starts the full connection list once the chats are done. Throttled: many events arrive per second.
 */
export async function refreshFirstSync(accountId: string, force = false) {
  if (!force && !(await redis.set(`lu:firstsync:${accountId}`, '1', 'PX', 2000, 'NX'))) return;
  await mutate(accountId, async (state) => {
    const [c] = await sql`
      SELECT count(*)::int AS conversations,
             count(*) FILTER (WHERE history_requested_at >= ${state.startedAt})::int AS requested,
             count(*) FILTER (WHERE history_synced_at >= ${state.startedAt})::int AS synced
      FROM conversations WHERE account_id = ${accountId}`;
    state.conversations.loaded = Math.max(state.conversations.loaded, Math.min(c.conversations, state.conversations.target));
    state.history = { total: c.requested, done: Math.min(c.synced, c.requested) };
    const chatsDone = state.conversations.done && state.history.done >= state.history.total;
    if (chatsDone && !state.fullConnectionsRequested && !state.connections.done) {
      state.fullConnectionsRequested = true;
      state.connectionsStartedAt = null;
      state.fullConnectionsCmdId = await sendCommand(accountId, {
        type: 'sync_connections',
        maxScrolls: FULL_CONNECTION_SCROLLS,
        progress: true,
      });
    }
    if (chatsDone && state.connections.done) state.finishedAt = new Date().toISOString();
  });
}

/** Progress reported by the bridge while a list loads. */
export async function onProgress(accountId: string, p: BridgeEventMap['progress']) {
  await mutate(accountId, (state) => {
    if (p.kind === 'conversations') {
      state.conversations.loaded = Math.max(state.conversations.loaded, p.loaded);
      return;
    }
    const now = Date.now();
    state.connectionsStartedAt ??= new Date(now).toISOString();
    const loaded = Math.max(p.loaded, state.connections.loaded);
    const total = p.total ?? state.connections.total;
    // Time left from the pace so far (only once there's enough to measure).
    const elapsedMin = (now - Date.parse(state.connectionsStartedAt)) / 60_000;
    const rate = elapsedMin > 0.5 && loaded > 0 ? loaded / elapsedMin : null;
    state.connections = {
      loaded,
      total,
      done: state.connections.done,
      etaMinutes: total && rate ? Math.max(0, Math.ceil((total - loaded) / rate)) : null,
    };
  });
  await refreshFirstSync(accountId);
}

/** A background sync finished (from the bridge's result). */
export async function onSyncResult(accountId: string, r: BridgeEventMap['result']) {
  if (r.type === 'sync_thread' && r.ok && r.conversationUrn) {
    await sql`
      UPDATE conversations SET history_synced_at = now()
      WHERE account_id = ${accountId} AND thread_urn = ${r.conversationUrn}`;
  }
  await mutate(accountId, (state) => {
    if (r.type === 'sync_inbox') state.conversations.done = true;
    if (r.type === 'sync_connections') {
      // The quick pass only finishes the list when it already reached LinkedIn's total.
      const complete = state.connections.total !== null && state.connections.loaded >= state.connections.total;
      if (r.cmdId === state.fullConnectionsCmdId || complete) state.connections = { ...state.connections, done: true, etaMinutes: 0 };
    }
    if (r.type === 'sync_thread') return false; // counted from the database in the refresh below
  });
  await refreshFirstSync(accountId, r.type !== 'sync_thread');
}
