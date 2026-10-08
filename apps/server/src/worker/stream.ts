import type { Redis } from 'ioredis';
import { logger } from '../lib/logger.ts';

type Entries = [string, [string, string[]][]][] | null;

const ATTEMPTS = 3;
/** Entries that kept failing are kept here (not dropped) for inspection: `XRANGE <stream>:dead - +`. */
const deadLetter = (stream: string) => `${stream}:dead`;

/** Last time a stream loop made progress (a read returned or timed out, an entry was handled). */
export let lastAlive = Date.now();

/**
 * Reads a Redis stream through a consumer group, one JSON entry at a time, forever.
 * An entry is acknowledged only after it was handled; a failing one is retried (a database blip shouldn't
 * lose a message) and after ATTEMPTS moved to the dead-letter stream. On start, entries left pending by
 * a previous run are handled first.
 */
export async function consumeStream<T>(opts: {
  redis: Redis;
  blocking: Redis;
  stream: string;
  group: string;
  consumer: string;
  handle: (entry: T) => Promise<unknown>;
}) {
  const { redis, blocking, stream, group, consumer, handle } = opts;
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (e) {
    if (!String((e as Error).message).includes('BUSYGROUP')) throw e;
  }
  let cursor = '0';
  for (;;) {
    try {
      const res = (await blocking.xreadgroup('GROUP', group, consumer, 'COUNT', 50, 'BLOCK', 5000, 'STREAMS', stream, cursor)) as Entries;
      lastAlive = Date.now();
      const entries = res?.[0]?.[1] ?? [];
      if (cursor !== '>' && !entries.length) {
        cursor = '>';
        continue;
      }
      for (const [id, fields] of entries) {
        const raw = fields[fields.indexOf('json') + 1];
        let handled = false;
        for (let attempt = 1; attempt <= ATTEMPTS && !handled; attempt++) {
          try {
            await handle(JSON.parse(raw) as T);
            handled = true;
          } catch (err) {
            logger.error({ err, stream, id, attempt }, 'stream entry failed');
            if (err instanceof SyntaxError) break; // unparseable: retrying won't help
            if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          }
        }
        if (!handled) await redis.xadd(deadLetter(stream), 'MAXLEN', '~', '10000', '*', 'id', id, 'json', raw);
        await redis.xack(stream, group, id);
        lastAlive = Date.now();
        if (cursor !== '>') cursor = id;
      }
    } catch (err) {
      logger.error({ err, stream }, 'stream read failed');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
