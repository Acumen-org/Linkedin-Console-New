// Redis contract between the app (api/worker) and this account's bridge.
//   li:events                 bridge → worker   (all accounts, one stream)
//   li:cmd:<accountId>        api/worker → bridge
//   li:reply:<cmdId>          bridge → api      (request/response commands, e.g. fetch_media)
import Redis from 'ioredis';

export function createStreams({ redisUrl, accountId }) {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const blocking = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const cmdStream = `li:cmd:${accountId}`;
  const consumer = `bridge-${process.pid}`;

  async function emit(type, data) {
    await redis.xadd('li:events', 'MAXLEN', '~', '50000', '*', 'json', JSON.stringify({ accountId, type, data, at: Date.now() }));
  }

  async function reply(cmdId, payload) {
    const key = `li:reply:${cmdId}`;
    await redis.multi().lpush(key, JSON.stringify(payload)).expire(key, 120).exec();
  }

  async function ensureGroup() {
    try { await redis.xgroup('CREATE', cmdStream, 'bridge', '$', 'MKSTREAM'); } catch (e) { if (!String(e.message).includes('BUSYGROUP')) throw e; }
  }

  /** Calls handler(cmd) for each command, one at a time, forever. */
  async function consume(handler) {
    await ensureGroup();
    // Re-deliver anything left pending by a previous crash first ('0'), then new ones ('>').
    let cursor = '0';
    for (;;) {
      try {
        const res = await blocking.xreadgroup('GROUP', 'bridge', consumer, 'COUNT', 10, 'BLOCK', 5000, 'STREAMS', cmdStream, cursor);
        const entries = res?.[0]?.[1] ?? [];
        if (cursor === '0' && entries.length === 0) { cursor = '>'; continue; }
        for (const [id, fields] of entries) {
          const json = fields[fields.indexOf('json') + 1];
          let cmd = null;
          try { cmd = JSON.parse(json); } catch {}
          if (cmd) {
            try { await handler(cmd); } catch (e) { console.error('[bridge] command failed', cmd.type, e); }
          }
          await redis.xack(cmdStream, 'bridge', id);
        }
      } catch (e) {
        console.error('[bridge] stream error', e.message);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return { redis, emit, reply, consume };
}
