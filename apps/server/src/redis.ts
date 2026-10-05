import { Redis } from 'ioredis';
import { config } from './config.ts';

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });

export const newRedis = () => new Redis(config.redisUrl, { maxRetriesPerRequest: null });

/** Push a realtime event to browsers (the api process relays these to Socket.IO rooms). */
export async function publish(rooms: string | string[], event: string, data: unknown) {
  await redis.publish('lu:emit', JSON.stringify({ rooms: Array.isArray(rooms) ? rooms : [rooms], event, data }));
}
