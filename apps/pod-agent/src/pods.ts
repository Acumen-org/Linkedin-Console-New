// Account pods through the Docker API.
// A pod = `pod-<id>` (Chrome, on the pods network: reaches Redis and the internet, not the api or database) + `pod-<id>-sidecar`
// (Live View + bridge, shares Chrome's network namespace so CDP stays on 127.0.0.1).
import fs from 'node:fs';
import { config } from './config.ts';
import { docker } from './docker.ts';
import { podRedisUrl, removePodRedisUser } from './redis-acl.ts';
import { registryAuthHeader } from './registry-auth.ts';

export interface PodSpec {
  id: string;
  timezone: string;
  language: string;
  proxyServer: string;
}

export interface PodStatus {
  id: string;
  chrome: string;
  sidecar: string;
  running: boolean;
  /** Both containers run the images this pod-agent would use now (false after a new version was deployed). */
  current: boolean;
}

const names = (id: string) => ({ chrome: `pod-${id}`, sidecar: `pod-${id}-sidecar`, profile: `linkedin-console_profile_${id}` });
const labels = (id: string) => ({ 'linkedin-console.pod': id });
const inspect = (name: string) => docker.inspect(name);

async function ensureStarted(name: string) {
  const info = await inspect(name);
  if (info && !info.State.Running) await docker.start(name);
}

async function removeContainer(name: string) {
  if (await inspect(name)) await docker.remove(name);
}

export async function status(id: string): Promise<PodStatus> {
  const n = names(id);
  const [c, s, chromeId, sidecarId] = await Promise.all([
    inspect(n.chrome),
    inspect(n.sidecar),
    docker.imageId(config.chromeImage),
    docker.imageId(config.sidecarImage),
  ]);
  return {
    id,
    chrome: c ? c.State.Status : 'missing',
    sidecar: s ? s.State.Status : 'missing',
    running: !!(c?.State.Running && s?.State.Running),
    // A desired image not on this machine yet means a new version: it is pulled before anything is replaced.
    current: !!c && !!s && c.Image === chromeId && s.Image === sidecarId,
  };
}

/** X-Registry-Auth for the image's registry, from the Docker config file (REGISTRY_AUTH_FILE), if it has a login. */
function registryAuth(ref: string): string | null {
  if (!config.registryAuthFile) return null;
  try {
    return registryAuthHeader(ref, fs.readFileSync(config.registryAuthFile, 'utf8'));
  } catch {
    return null; // file not mounted or unreadable: pull without a login
  }
}

/** Makes sure the image is on this machine (pulls it from its registry if not). */
export async function ensureImage(ref: string) {
  if (await docker.imageId(ref)) return;
  await docker.pull(ref, registryAuth(ref));
}

export async function createPod({ id, timezone, language, proxyServer }: PodSpec): Promise<PodStatus> {
  const n = names(id);
  await ensureImage(config.chromeImage);
  await ensureImage(config.sidecarImage);
  // Chrome can't hold proxy credentials: if the proxy needs a login, Chrome talks to a
  // local forwarder in the sidecar (127.0.0.1:3128) which adds the credentials.
  const needsForwarder = /^https?:\/\/[^/]*@/.test(proxyServer);
  const chromeProxy = needsForwarder ? 'http://127.0.0.1:3128' : proxyServer;

  if (!(await inspect(n.chrome))) {
    await docker.createVolume(n.profile, labels(id));
    await docker.create(n.chrome, {
      Image: config.chromeImage,
      Labels: labels(id),
      Env: [`TZ=${timezone}`, `CHROME_LANG=${language}`, `PROXY_SERVER=${chromeProxy}`, 'SCREEN_W=1440', 'SCREEN_H=900'],
      HostConfig: {
        Binds: [`${n.profile}:/data/profile`, `${config.filesVolume}:/data/files`],
        ShmSize: 2 * 1024 * 1024 * 1024,
        Memory: config.podMemoryBytes,
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: config.network,
      },
      NetworkingConfig: { EndpointsConfig: { [config.network]: { Aliases: [n.chrome] } } },
    });
  }
  await ensureStarted(n.chrome);

  if (!(await inspect(n.sidecar))) {
    const redisUrl = await podRedisUrl(id);
    await docker.create(n.sidecar, {
      Image: config.sidecarImage,
      Labels: labels(id),
      Env: [
        `ACCOUNT_ID=${id}`,
        `REDIS_URL=${redisUrl}`,
        'FILES_DIR=/data/files',
        `TZ=${timezone}`,
        `LIVE_SECRET=${config.liveSecret}`,
        `UPSTREAM_PROXY=${needsForwarder ? proxyServer : ''}`,
        ...config.sidecarEnv,
      ],
      HostConfig: {
        Binds: [`${config.filesVolume}:/data/files`],
        NetworkMode: `container:${n.chrome}`,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: 256 * 1024 * 1024,
      },
    });
  }
  await ensureStarted(n.sidecar);
  // The new chrome/sidecar images are now referenced by this pod, so dropping unused ones can't delete them:
  // clean up old images from past deploys so the host disk doesn't fill up (until:1h keeps anything just pulled).
  docker.pruneImages().catch(() => {});
  return status(id);
}

export async function deletePod(id: string, wipe: boolean) {
  const n = names(id);
  await removeContainer(n.sidecar);
  await removeContainer(n.chrome);
  if (wipe) await docker.removeVolume(n.profile);
  await removePodRedisUser(id);
  return { id, deleted: true, wiped: wipe };
}

export async function restartPod(id: string) {
  const n = names(id);
  for (const name of [n.chrome, n.sidecar]) if (await inspect(name)) await docker.restart(name, 5);
  return status(id);
}

/** Recreate containers (e.g. after an image update) but keep the profile volume = keep the LinkedIn session. */
export async function recreatePod(spec: PodSpec) {
  // New images first: if they can't be pulled, the running pod stays as it is.
  await ensureImage(config.chromeImage);
  await ensureImage(config.sidecarImage);
  await deletePod(spec.id, false);
  return createPod(spec);
}

export async function listPods() {
  const list = await docker.listByLabel('linkedin-console.pod');
  const ids = [...new Set(list.map((c) => c.Labels['linkedin-console.pod']))];
  return Promise.all(ids.map(status));
}
