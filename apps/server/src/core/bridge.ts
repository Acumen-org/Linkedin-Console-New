/** Talking to an account's bridge (in its pod) over Redis, and to the pod-agent over HTTP. */
import crypto from 'node:crypto';
import { type BridgeCommand, commandStream, replyKey } from '@linkedin-console/contracts';
import { config } from '../lib/config.ts';
import { HttpError } from '../lib/errors.ts';
import { newRedis, redis } from '../lib/redis.ts';

export async function sendCommand(accountId: string, cmd: BridgeCommand, ownerUserId?: string) {
  const cmdId = cmd.cmdId ?? crypto.randomUUID();
  await redis.xadd(commandStream(accountId), 'MAXLEN', '~', '2000', '*', 'json', JSON.stringify({ ...cmd, cmdId }));
  if (ownerUserId) await redis.set(`li:cmdowner:${cmdId}`, ownerUserId, 'EX', 3600);
  return cmdId;
}

/** Sends a command and waits for the bridge's direct reply (e.g. fetch_media). */
export async function requestCommand<T>(accountId: string, cmd: BridgeCommand, timeoutSec = 60): Promise<T> {
  const cmdId = crypto.randomUUID();
  const conn = newRedis();
  try {
    await sendCommand(accountId, { ...cmd, cmdId });
    const res = await conn.blpop(replyKey(cmdId), timeoutSec);
    if (!res) throw new HttpError(504, 'The LinkedIn account did not respond in time');
    return JSON.parse(res[1]) as T;
  } finally {
    conn.disconnect();
  }
}

export interface PodSpec {
  timezone: string;
  language: string;
  proxyServer?: string | null;
}

export interface PodStatus {
  id: string;
  chrome: string;
  sidecar: string;
  running: boolean;
  /** Runs the images the pod-agent would use now (false after a new version was deployed). */
  current?: boolean;
}

async function podAgent<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${config.podAgentUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${config.podAgentToken}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new HttpError(502, `pod-agent: ${json.error ?? res.status}`);
  return json;
}

export const pods = {
  create: (id: string, spec: PodSpec) => podAgent<PodStatus>('PUT', `/pods/${id}`, spec),
  status: (id: string) => podAgent<PodStatus>('GET', `/pods/${id}`),
  list: () => podAgent<PodStatus[]>('GET', '/pods'),
  restart: (id: string) => podAgent<PodStatus>('POST', `/pods/${id}/restart`),
  recreate: (id: string, spec: PodSpec) => podAgent<PodStatus>('POST', `/pods/${id}/recreate`, spec),
  remove: (id: string, wipe: boolean) => podAgent<{ deleted: boolean }>('DELETE', `/pods/${id}${wipe ? '?wipe=1' : ''}`),
};

/** Pod settings from an accounts row. */
export const podSpecOf = (a: Record<string, unknown>): PodSpec => ({
  timezone: String(a.timezone),
  language: String(a.language),
  proxyServer: (a.proxyServer as string | null) ?? null,
});
