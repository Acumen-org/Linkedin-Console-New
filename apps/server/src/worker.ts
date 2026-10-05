// Worker: consumes bridge events from all account pods and runs periodic jobs.
import os from 'node:os';
import { migrate, sql } from './db.ts';
import { newRedis, publish, redis } from './redis.ts';
import { sendCommand } from './bridgeClient.ts';
import { alertAccountStatus } from './alerts.ts';
import { onContacts, onConversations, onMessages, onResult, onSeen, onSession, onTyping } from './ingest.ts';

await migrate();

const STREAM = 'li:events';
const GROUP = 'worker';
const consumer = `${os.hostname()}-${process.pid}`;
const blocking = newRedis();

try { await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM'); } catch (e) { if (!String((e as Error).message).includes('BUSYGROUP')) throw e; }

async function handle(ev: { accountId: string; type: string; data: any }) {
  const [exists] = await sql`SELECT 1 FROM accounts WHERE id = ${ev.accountId}`;
  if (!exists) return; // account was deleted
  switch (ev.type) {
    case 'session': return onSession(ev.accountId, ev.data);
    case 'conversations': return onConversations(ev.accountId, ev.data);
    case 'messages': return onMessages(ev.accountId, ev.data);
    case 'seen': return onSeen(ev.accountId, ev.data);
    case 'typing': return onTyping(ev.accountId, ev.data);
    case 'contacts': return onContacts(ev.accountId, ev.data);
    case 'result': return onResult(ev.accountId, ev.data);
  }
}

async function consume() {
  let cursor = '0'; // first re-process anything left pending by a crash
  for (;;) {
    try {
      const res = (await blocking.xreadgroup('GROUP', GROUP, consumer, 'COUNT', 50, 'BLOCK', 5000, 'STREAMS', STREAM, cursor)) as [string, [string, string[]][]][] | null;
      const entries = res?.[0]?.[1] ?? [];
      if (cursor === '0' && !entries.length) { cursor = '>'; continue; }
      for (const [id, fields] of entries) {
        try {
          await handle(JSON.parse(fields[fields.indexOf('json') + 1]));
        } catch (e) {
          console.error('[worker] event failed', (e as Error).message);
        }
        await redis.xack(STREAM, GROUP, id);
      }
    } catch (e) {
      console.error('[worker] stream error', (e as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// Every minute: mark pods that stopped reporting as OFFLINE; schedule daily connection syncs.
async function periodic() {
  const offline = await sql`
    UPDATE accounts SET status = 'OFFLINE'
    WHERE status IN ('CONNECTED', 'AWAITING_LOGIN', 'NEEDS_ATTENTION') AND last_seen_at < now() - interval '4 minutes'
    RETURNING id, status, display_name, avatar_url, headline, public_id`;
  for (const a of offline) {
    await publish([`acc:${a.id}`, 'admins'], 'account.updated', a);
    await alertAccountStatus(a.id, 'OFFLINE');
  }

  const connected = await sql`SELECT id FROM accounts WHERE status = 'CONNECTED'`;
  for (const { id } of connected) {
    // Key exists = synced recently (or just connected); expiry = time for the next sync.
    if (await redis.set(`lu:connsync:${id}`, '1', 'EX', 24 * 3600 + Math.floor(Math.random() * 3600), 'NX')) {
      await sendCommand(id, { type: 'sync_connections' });
    }
  }
}

setInterval(() => periodic().catch((e) => console.error('[worker] periodic', e.message)), 60_000);
console.log('[worker] started');
await consume();
