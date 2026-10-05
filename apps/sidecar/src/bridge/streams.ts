// Redis side of the bridge protocol (see @linkunify/contracts → bridge.ts).
import {
  type BridgeCommand,
  type BridgeEventMap,
  type BridgeEventType,
  commandStream,
  EVENTS_STREAM,
  type FetchMediaReply,
  replyKey,
} from '@linkunify/contracts';
import { Redis } from 'ioredis';
import { logger } from '../logger.ts';

export type Emit = <K extends BridgeEventType>(type: K, data: BridgeEventMap[K]) => Promise<void>;
export type Command = BridgeCommand & { cmdId: string };

export interface Streams {
  redis: Redis;
  emit: Emit;
  reply: (cmdId: string, payload: FetchMediaReply) => Promise<void>;
  consume: (handler: (cmd: Command) => Promise<unknown>) => Promise<never>;
}

export function createStreams(redisUrl: string, accountId: string): Streams {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const blocking = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const stream = commandStream(accountId);
  const consumer = `bridge-${process.pid}`;

  const emit: Emit = async (type, data) => {
    await redis.xadd(EVENTS_STREAM, 'MAXLEN', '~', '50000', '*', 'json', JSON.stringify({ accountId, type, data, at: Date.now() }));
  };

  async function reply(cmdId: string, payload: FetchMediaReply) {
    const key = replyKey(cmdId);
    await redis.multi().lpush(key, JSON.stringify(payload)).expire(key, 120).exec();
  }

  /** Runs handler for each command, one at a time, forever (re-delivers unacked ones after a crash). */
  async function consume(handler: (cmd: Command) => Promise<unknown>): Promise<never> {
    try {
      await redis.xgroup('CREATE', stream, 'bridge', '$', 'MKSTREAM');
    } catch (e) {
      if (!String((e as Error).message).includes('BUSYGROUP')) throw e;
    }
    let cursor = '0';
    for (;;) {
      try {
        const res = (await blocking.xreadgroup('GROUP', 'bridge', consumer, 'COUNT', 10, 'BLOCK', 5000, 'STREAMS', stream, cursor)) as
          | [string, [string, string[]][]][]
          | null;
        const entries = res?.[0]?.[1] ?? [];
        if (cursor === '0' && !entries.length) {
          cursor = '>';
          continue;
        }
        for (const [id, fields] of entries) {
          let cmd: Command | null = null;
          try {
            cmd = JSON.parse(fields[fields.indexOf('json') + 1]);
          } catch {}
          if (cmd) {
            try {
              await handler(cmd);
            } catch (err) {
              logger.error({ err, cmd: cmd.type }, 'command failed');
            }
          }
          await redis.xack(stream, 'bridge', id);
        }
      } catch (err) {
        logger.error({ err }, 'command stream error');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return { redis, emit, reply, consume };
}
