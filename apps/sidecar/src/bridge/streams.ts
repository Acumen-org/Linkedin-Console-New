// Redis side of the bridge protocol (see @linkedin-console/contracts → bridge.ts).
import {
  type BridgeCommand,
  type BridgeEventMap,
  type BridgeEventType,
  commandStream,
  EVENTS_STREAM,
  type FetchMediaReply,
  RESULTS_STREAM,
  replyKey,
} from '@linkedin-console/contracts';
import { Redis } from 'ioredis';
import { logger } from '../logger.ts';

export type Emit = <K extends BridgeEventType>(type: K, data: BridgeEventMap[K]) => Promise<void>;
/** queuedAt: when the app queued it (from the stream entry id), to skip sends that waited too long. */
export type Command = BridgeCommand & { cmdId: string; queuedAt: number };

const isSend = (cmd: Command) => cmd.type === 'send_message' || cmd.type === 'start_chat';

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
    const target = type === 'result' ? RESULTS_STREAM : EVENTS_STREAM;
    await redis.xadd(target, 'MAXLEN', '~', '50000', '*', 'json', JSON.stringify({ accountId, type, data, at: Date.now() }));
  };

  async function reply(cmdId: string, payload: FetchMediaReply) {
    const key = replyKey(cmdId);
    await redis.multi().lpush(key, JSON.stringify(payload)).expire(key, 120).exec();
  }

  async function run(handler: (cmd: Command) => Promise<unknown>, id: string, fields: string[]) {
    let cmd: Command | null = null;
    try {
      cmd = { ...JSON.parse(fields[fields.indexOf('json') + 1]), queuedAt: Number(id.split('-')[0]) };
    } catch {}
    // Sends are acknowledged before they run: after a crash they are never replayed (no double sends).
    // The app marks a send that never reports back as failed; LinkedIn's copy corrects it if it went out.
    if (!cmd || isSend(cmd)) await redis.xack(stream, 'bridge', id);
    if (!cmd) return;
    try {
      await handler(cmd);
    } catch (err) {
      logger.error({ err, cmd: cmd.type }, 'command failed');
    }
    if (!isSend(cmd)) await redis.xack(stream, 'bridge', id);
  }

  /**
   * Hands every command to the handler as soon as it arrives (the handler orders and paces them), forever.
   * Unacked commands from before a crash are replayed first, one at a time.
   */
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
          const done = run(handler, id, fields).catch((err) => logger.error({ err }, 'command ack failed'));
          if (cursor === '0') await done;
        }
      } catch (err) {
        logger.error({ err }, 'command stream error');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return { redis, emit, reply, consume };
}
