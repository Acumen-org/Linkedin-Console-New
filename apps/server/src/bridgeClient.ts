// Talking to an account's bridge (in its pod) through Redis, and to the pod-agent over HTTP.
import crypto from 'node:crypto';
import { redis, newRedis } from './redis.ts';
import { config } from './config.ts';
import { HttpError } from './auth.ts';

export type Command = { type: string; cmdId?: string; [k: string]: unknown };

export async function sendCommand(accountId: string, cmd: Command, ownerUserId?: string) {
  const cmdId = cmd.cmdId ?? crypto.randomUUID();
  await redis.xadd(`li:cmd:${accountId}`, 'MAXLEN', '~', '2000', '*', 'json', JSON.stringify({ ...cmd, cmdId }));
  if (ownerUserId) await redis.set(`li:cmdowner:${cmdId}`, ownerUserId, 'EX', 3600);
  return cmdId;
}

/** Send a command and wait for the bridge's direct reply (e.g. fetch_media). */
export async function requestCommand<T = any>(accountId: string, cmd: Command, timeoutSec = 60): Promise<T> {
  const cmdId = crypto.randomUUID();
  const conn = newRedis();
  try {
    await sendCommand(accountId, { ...cmd, cmdId });
    const res = await conn.blpop(`li:reply:${cmdId}`, timeoutSec);
    if (!res) throw new HttpError(504, 'The LinkedIn account did not respond in time');
    return JSON.parse(res[1]) as T;
  } finally {
    conn.disconnect();
  }
}

async function podAgent(method: string, path: string, body?: unknown) {
  const res = await fetch(`${config.podAgentUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.podAgentToken}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, `pod-agent: ${json.error ?? res.status}`);
  return json;
}

export type PodSpec = { timezone: string; language: string; proxyServer?: string | null };

export const pods = {
  create: (id: string, spec: PodSpec) => podAgent('PUT', `/pods/${id}`, spec),
  status: (id: string) => podAgent('GET', `/pods/${id}`),
  list: () => podAgent('GET', '/pods'),
  restart: (id: string) => podAgent('POST', `/pods/${id}/restart`),
  recreate: (id: string, spec: PodSpec) => podAgent('POST', `/pods/${id}/recreate`, spec),
  remove: (id: string, wipe: boolean) => podAgent('DELETE', `/pods/${id}${wipe ? '?wipe=1' : ''}`),
};
