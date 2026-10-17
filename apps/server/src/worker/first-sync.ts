// First sync of a newly connected account, so it looks complete right away instead of filling up only as new
// messages arrive:
//   1. the 100 most recent conversations (about a minute), plus the newest connections (quick pass)
//   2. recent history of each of those, newest first, at a calm pace (about 5 minutes); a conversation
//      someone opens jumps the queue
//   3. then the full connection list in the background, with progress and a time estimate
// Progress is stored on the account (sync_state) and pushed to the team.
import { type AccountSync, ADMINS_ROOM, accountRoom, type BridgeEventMap, type InboxCheck } from '@linkedin-console/contracts';
import { audit } from '../core/audit.ts';
import { sendCommand } from '../core/bridge.ts';
import { sql } from '../lib/db.ts';
import { publish, redis } from '../lib/redis.ts';
import { alertAdmins } from './alerts.ts';

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
const CATCH_UP_SCROLLS = 2;

/**
 * The account is back after being offline (logged out, browser restarted): messages that came in meanwhile
 * were never seen. Reload the recent chats; the ones with activity since the newest message we have get their
 * history fetched again (see missedWhileAway).
 */
export async function catchUp(accountId: string) {
  const [c] = await sql`SELECT max(last_message_at) AS newest FROM conversations WHERE account_id = ${accountId}`;
  const since = (c?.newest as Date | null)?.getTime() ?? 0;
  await redis.set(catchUpKey(accountId), JSON.stringify({ since, at: Date.now() }), 'EX', CATCH_UP_MINUTES * 60);
  // Light: the most recent chats only (the full 100-chat load is for the first connection and Re-sync).
  await sendCommand(accountId, { type: 'sync_inbox', scrolls: CATCH_UP_SCROLLS });
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

/**
 * A full connection sync that stops advancing — the pod was recreated mid-scroll (a deploy, a restart) so its
 * result was lost — is never completed on its own: `fullConnectionsRequested` blocks re-issuing it. Re-send it
 * when the loaded count hasn't moved for a while and the account is connected, so a large connection list
 * eventually finishes instead of staying stuck (e.g. 327 of 2427 forever).
 */
export async function retryStuckConnections() {
  const rows = await sql<{ id: string; syncState: SyncState | null }[]>`
    SELECT id, sync_state FROM accounts WHERE status = 'CONNECTED' AND sync_state IS NOT NULL`;
  for (const { id, syncState: s } of rows) {
    if (!s || s.finishedAt || !s.fullConnectionsRequested || !s.connections || s.connections.done) continue;
    const loaded = s.connections.loaded ?? 0;
    const key = `lu:connstall:${id}`;
    const now = Date.now();
    const prev = await redis.get(key);
    if (!prev) {
      await redis.set(key, `${loaded}:${now}`, 'EX', 6 * 3600);
      continue;
    }
    const [prevLoaded, prevAt] = prev.split(':').map(Number);
    if (loaded > prevLoaded) {
      await redis.set(key, `${loaded}:${now}`, 'EX', 6 * 3600); // still progressing
      continue;
    }
    if (now - prevAt < 12 * 60_000) continue; // give the running sync time before calling it stuck
    const cmdId = await sendCommand(id, { type: 'sync_connections', maxScrolls: FULL_CONNECTION_SCROLLS, progress: true });
    await mutate(id, (st) => {
      st.fullConnectionsCmdId = cmdId;
      st.connectionsStartedAt = null;
    });
    await redis.set(key, `${loaded}:${now}`, 'EX', 6 * 3600);
  }
}

/** Progress reported by the bridge while a list loads. */
export async function onProgress(accountId: string, p: BridgeEventMap['progress']) {
  // A "Load all chats" run: its own progress (the first sync may be long finished).
  if (p.kind === 'conversations') {
    const loading = await allChatsLoading(accountId);
    if (loading) {
      const next = { ...loading, loaded: Math.max(loading.loaded, p.loaded) };
      await redis.set(LOAD_KEY(accountId), JSON.stringify(next), 'KEEPTTL');
      await publish([accountRoom(accountId), ADMINS_ROOM], 'account.updated', { id: accountId, allChats: next });
    }
  }
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
/** How the last conversation list load went; alerts the admins (once a day) when LinkedIn's data stopped coming. */
async function recordInboxCheck(accountId: string, inbox: InboxCheck) {
  const loading = await redis.get(LOAD_KEY(accountId));
  const check = { ...inbox, at: new Date().toISOString(), full: !!loading };
  if (loading) await redis.del(LOAD_KEY(accountId));
  await sql`UPDATE accounts SET inbox_check = ${sql.json(check as never)} WHERE id = ${accountId}`;
  await publish([accountRoom(accountId), ADMINS_ROOM], 'account.updated', { id: accountId, inboxCheck: check });
  // Most of what the page listed wasn't in LinkedIn's data: reading it broke (format change).
  const degraded = inbox.listed >= 5 && inbox.recognised < inbox.listed / 2;
  if (degraded && (await redis.set(`lu:inboxdegraded:${accountId}`, '1', 'EX', 24 * 3600, 'NX'))) {
    const [a] = await sql`SELECT label FROM accounts WHERE id = ${accountId}`;
    await audit({ accountId, action: 'account.sync_degraded', meta: { ...inbox } });
    await alertAdmins(
      `Chats not syncing fully: ${a?.label ?? accountId}`,
      `LinkedIn's page listed ${inbox.listed} chats but its data described only ${inbox.recognised}. The others were added from the page (names only; their messages may be missing) until the bridge is updated for LinkedIn's change. See Accounts → Sync report.`,
      '/accounts',
    );
  }
}

const LOAD_KEY = (accountId: string) => `lu:inboxload:${accountId}`;

/** "Load all chats": the whole conversation list, at the usual human pace, with progress. */
export async function loadAllChats(accountId: string) {
  if (await redis.get(LOAD_KEY(accountId))) return false;
  await redis.set(LOAD_KEY(accountId), JSON.stringify({ loaded: 0, startedAt: new Date().toISOString() }), 'EX', 3 * 3600);
  await sendCommand(accountId, { type: 'sync_inbox', target: ALL_CHATS });
  return true;
}

/** Progress of a "Load all chats" run (null when none is running). */
export async function allChatsLoading(accountId: string): Promise<{ loaded: number; startedAt: string } | null> {
  const raw = await redis.get(LOAD_KEY(accountId));
  return raw ? JSON.parse(raw) : null;
}

const ALL_CHATS = 3000;

export async function onSyncResult(accountId: string, r: BridgeEventMap['result']) {
  if (r.type === 'sync_inbox' && r.inbox) await recordInboxCheck(accountId, r.inbox);
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

/** Why a recent chat's history isn't in yet (shown in the sync report). */
export type HistoryWait =
  | 'no_thread' // LinkedIn gave no thread id: can't be fetched
  | 'unread' // unread, and the quiet history request isn't learned yet: opening it would mark it read
  | 'queued' // requested less than 10 minutes ago
  | 'retrying' // requested earlier without an answer; retried every 10 minutes
  | 'not_requested';

/**
 * What the first sync actually loaded, for checking it: the 100 most recent chats, which have their history,
 * and why the others are still waiting.
 */
export async function syncReport(accountId: string) {
  const [a] = await sql`SELECT sync_state, status, inbox_check FROM accounts WHERE id = ${accountId}`;
  const templates = JSON.parse((await redis.get(`li:tpl:${accountId}`)) ?? '{}') as { messages?: unknown; send?: unknown };
  const learned = !!templates.messages;
  const rows = await sql`
    SELECT c.id, c.title, c.participants, c.last_message_at, c.unread_count, c.thread_id,
           c.history_requested_at, c.history_synced_at,
           (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS messages
    FROM conversations c WHERE c.account_id = ${accountId}
    ORDER BY c.last_message_at DESC NULLS LAST LIMIT ${FIRST_SYNC_CONVERSATIONS}`;
  const [{ total, connections }] = await sql`
    SELECT (SELECT count(*)::int FROM conversations WHERE account_id = ${accountId}) AS total,
           (SELECT count(*)::int FROM contacts WHERE account_id = ${accountId} AND is_connection) AS connections`;
  const waitOf = (r: (typeof rows)[number]): HistoryWait | null => {
    if (r.historySyncedAt) return null;
    if (!r.threadId) return 'no_thread';
    if (!r.historyRequestedAt) return 'not_requested';
    if (r.unreadCount > 0 && !learned) return 'unread';
    return Date.now() - r.historyRequestedAt.getTime() < 10 * 60_000 ? 'queued' : 'retrying';
  };
  const chats = rows.map((r) => ({
    id: r.id as string,
    name: (r.title as string | null) ?? ((r.participants as { name: string }[])?.map((p) => p.name).join(', ') || 'LinkedIn Member'),
    lastMessageAt: r.lastMessageAt as Date | null,
    unread: r.unreadCount as number,
    messages: r.messages as number,
    historyAt: r.historySyncedAt as Date | null,
    waiting: waitOf(r),
  }));
  return {
    status: a?.status as string,
    sync: a?.syncState ?? null,
    historyRequestLearned: learned,
    inboxCheck: a?.inboxCheck ?? null,
    allChats: await allChatsLoading(accountId),
    sendRequestLearned: !!templates.send,
    conversations: total as number,
    connections: connections as number,
    recent: {
      count: chats.length,
      withHistory: chats.filter((c) => !c.waiting).length,
      waiting: chats.filter((c) => c.waiting).length,
    },
    chats,
  };
}

/** Asks again for the history of the recent chats that don't have it yet. Returns how many were asked for. */
export async function retryMissingHistory(accountId: string) {
  const due = await sql`
    UPDATE conversations c SET history_requested_at = now()
    FROM (
      SELECT id FROM conversations WHERE account_id = ${accountId}
      ORDER BY last_message_at DESC NULLS LAST LIMIT ${FIRST_SYNC_CONVERSATIONS}
    ) recent
    WHERE c.id = recent.id AND c.history_synced_at IS NULL AND c.thread_id IS NOT NULL
    RETURNING c.thread_urn, c.thread_id, c.unread_count`;
  for (const c of due) {
    await sendCommand(accountId, {
      type: 'sync_thread',
      conversationUrn: c.threadUrn,
      threadId: c.threadId,
      allowOpen: c.unreadCount === 0,
    });
  }
  return due.length;
}
