import { REALTIME_CHANNEL, type RealtimeEvent, type ServerToClientEvents } from '@linkedin-console/contracts';
import { Redis } from 'ioredis';
import { config } from './config.ts';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

/** A separate connection, for blocking commands (XREAD/BLPOP) and pub/sub. */
export const newRedis = () => new Redis(config.redisUrl, { maxRetriesPerRequest: null });

/** Push a realtime event to browsers; the api process relays it to the Socket.IO rooms. */
export async function publish<E extends RealtimeEvent>(rooms: string | string[], event: E, data: Parameters<ServerToClientEvents[E]>[0]) {
  await redis.publish(REALTIME_CHANNEL, JSON.stringify({ rooms: Array.isArray(rooms) ? rooms : [rooms], event, data }));
}
