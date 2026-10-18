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
  /** The image id the container was created from. */
  Image: string;
}

/**
 * Pulls an image (POST /images/create). Docker answers 200 and reports a failure inside the stream, so the stream
 * is read to the end and checked. `auth`: X-Registry-Auth for a private registry.
 */
function pullImage(ref: string, auth: string | null): Promise<void> {
  const at = ref.lastIndexOf(':');
  const hasTag = at > ref.lastIndexOf('/');
  const image = hasTag ? ref.slice(0, at) : ref;
  const tag = hasTag ? ref.slice(at + 1) : 'latest';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: SOCKET,
        method: 'POST',
        path: `/images/create?fromImage=${enc(image)}&tag=${enc(tag)}`,
        headers: auth ? { 'X-Registry-Auth': auth } : {},
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          const failed = raw
            .split('\n')
            .map((l) => safeJson(l) as { error?: string } | string)
            .find((l) => typeof l === 'object' && l?.error);
          if ((res.statusCode ?? 500) >= 400 || failed)
            reject(new DockerError(res.statusCode ?? 500, `Pulling ${ref}: ${(failed as { error?: string })?.error ?? raw.slice(0, 200)}`));
          else resolve();
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10 * 60_000, () => req.destroy(new Error(`Pulling ${ref} timed out`)));
    req.end();
  });
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
  /** The image's id, or null when it isn't on this machine. */
  imageId: (ref: string) =>
    call<{ Id: string }>('GET', `/images/${enc(ref)}/json`).then(
      (i) => i.Id,
      (e) => {
        if (e instanceof DockerError && e.statusCode === 404) return null;
        throw e;
      },
    ),
  pull: pullImage,
  /**
   * Free disk by removing images no container uses (every deploy adds new SHA-tagged images; they pile up and
   * eventually fill the host, so pulls fail with "no space left on device") plus the build cache. Best-effort.
   * Returns bytes reclaimed.
   */
  pruneImages: async () => {
    const unused = enc(JSON.stringify({ dangling: ['false'] }));
    const img = await call<{ SpaceReclaimed?: number }>('POST', `/images/prune?filters=${unused}`).catch(
      () => ({}) as { SpaceReclaimed?: number },
    );
    const build = await call<{ SpaceReclaimed?: number }>('POST', '/build/prune').catch(() => ({}) as { SpaceReclaimed?: number });
    return (img.SpaceReclaimed ?? 0) + (build.SpaceReclaimed ?? 0);
  },
  listByLabel: (label: string) =>
    call<{ Labels: Record<string, string> }[]>('GET', `/containers/json?all=1&filters=${enc(JSON.stringify({ label: [label] }))}`),
};
