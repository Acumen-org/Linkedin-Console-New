// Redis side of the bridge protocol (see @linkedin-console/contracts → bridge.ts).
import {
  type BridgeCommand,
  type BridgeEventMap,
  type BridgeEventType,
  commandStream,
  EVENTS_STREAM,
  type FetchMediaReply,
  RESULTS_STREAM,
  type ResolveProfileReply,
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
  reply: (cmdId: string, payload: FetchMediaReply | ResolveProfileReply) => Promise<void>;
  consume: (handler: (cmd: Command) => Promise<unknown>) => Promise<never>;
}

export function createStreams(redisUrl: string, accountId: string): Streams {
  // Writes give up after a few retries during a Redis outage (logged) instead of queueing without limit in
  // this 256 MB process. The blocking reader waits for Redis to come back.
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 5 });
  const blocking = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const stream = commandStream(accountId);
  const consumer = `bridge-${process.pid}`;

  const emit: Emit = async (type, data) => {
    const target = type === 'result' ? RESULTS_STREAM : EVENTS_STREAM;
    await redis.xadd(target, 'MAXLEN', '~', '50000', '*', 'json', JSON.stringify({ accountId, type, data, at: Date.now() }));
  };

  async function reply(cmdId: string, payload: FetchMediaReply | ResolveProfileReply) {
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

  async function ensureGroup() {
    for (;;) {
      try {
        await redis.xgroup('CREATE', stream, 'bridge', '$', 'MKSTREAM');
        return;
      } catch (e) {
        if (String((e as Error).message).includes('BUSYGROUP')) return;
        logger.error({ err: e }, 'command stream setup failed, retrying');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  /**
   * Hands every command to the handler as soon as it arrives (the handler orders and paces them), forever.
   * Unacked commands from before a restart are handed over first (reading on from the last one seen, so
   * nothing waits behind them).
   */
  async function consume(handler: (cmd: Command) => Promise<unknown>): Promise<never> {
    await ensureGroup();
    let cursor = '0';
    for (;;) {
      try {
        const res = (await blocking.xreadgroup('GROUP', 'bridge', consumer, 'COUNT', 10, 'BLOCK', 5000, 'STREAMS', stream, cursor)) as
          | [string, [string, string[]][]][]
          | null;
        const entries = res?.[0]?.[1] ?? [];
        if (cursor !== '>' && !entries.length) {
          cursor = '>';
          continue;
        }
        for (const [id, fields] of entries) {
          run(handler, id, fields).catch((err) => logger.error({ err }, 'command ack failed'));
          if (cursor !== '>') cursor = id; // replaying pending entries: continue after this one
        }
      } catch (err) {
        if (String((err as Error).message).includes('NOGROUP')) await ensureGroup(); // stream was reset
        logger.error({ err }, 'command stream error');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  return { redis, emit, reply, consume };
}
