import type { Redis } from 'ioredis';
import { logger } from '../lib/logger.ts';

type Entries = [string, [string, string[]][]][] | null;

/**
 * Reads a Redis stream through a consumer group, one JSON entry at a time, forever.
 * On start it first re-processes entries left pending by a previous crash.
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
      const entries = res?.[0]?.[1] ?? [];
      if (cursor === '0' && !entries.length) {
        cursor = '>';
        continue;
      }
      for (const [id, fields] of entries) {
        try {
          await handle(JSON.parse(fields[fields.indexOf('json') + 1]) as T);
        } catch (err) {
          logger.error({ err, stream }, 'stream entry failed');
        }
        await redis.xack(stream, group, id);
      }
    } catch (err) {
      logger.error({ err, stream }, 'stream read failed');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
