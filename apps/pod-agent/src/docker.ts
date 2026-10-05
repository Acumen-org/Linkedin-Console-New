// Minimal Docker Engine API client over the Unix socket (only what the pod-agent needs).
// Replaces dockerode: no dependencies, much smaller image and memory footprint.
import http from 'node:http';

const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

export class DockerError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: SOCKET,
        method,
        path,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          const status = res.statusCode ?? 500;
          const data = raw ? safeJson(raw) : null;
          if (status >= 400) reject(new DockerError(status, (data as { message?: string })?.message ?? `Docker API ${status}`));
          else resolve(data as T);
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(60_000, () => req.destroy(new Error('Docker API timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const enc = encodeURIComponent;

export interface ContainerInfo {
  State: { Status: string; Running: boolean };
}

export const docker = {
  /** null when the container doesn't exist */
  inspect: (name: string) =>
    call<ContainerInfo>('GET', `/containers/${enc(name)}/json`).catch((e) => {
      if (e instanceof DockerError && e.statusCode === 404) return null;
      throw e;
    }),
  create: (name: string, spec: Record<string, unknown>) => call<{ Id: string }>('POST', `/containers/create?name=${enc(name)}`, spec),
  start: (name: string) => call<null>('POST', `/containers/${enc(name)}/start`),
  restart: (name: string, timeoutSec = 5) => call<null>('POST', `/containers/${enc(name)}/restart?t=${timeoutSec}`),
  remove: (name: string) => call<null>('DELETE', `/containers/${enc(name)}?force=true`),
  /** Idempotent: returns the existing volume if it already exists. */
  createVolume: (name: string, labels: Record<string, string>) => call<unknown>('POST', '/volumes/create', { Name: name, Labels: labels }),
  removeVolume: (name: string) =>
    call<null>('DELETE', `/volumes/${enc(name)}`).catch((e) => {
      if (e instanceof DockerError && e.statusCode === 404) return null;
      throw e;
    }),
  listByLabel: (label: string) =>
    call<{ Labels: Record<string, string> }[]>('GET', `/containers/json?all=1&filters=${enc(JSON.stringify({ label: [label] }))}`),
};
