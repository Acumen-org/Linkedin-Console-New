// Account pods through the Docker API.
// A pod = `pod-<id>` (Chrome, joins the app network) + `pod-<id>-sidecar`
// (Live View + bridge, shares Chrome's network namespace so CDP stays on 127.0.0.1).
import { config } from './config.ts';
import { docker } from './docker.ts';

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
  const [c, s] = await Promise.all([inspect(n.chrome), inspect(n.sidecar)]);
  return {
    id,
    chrome: c ? c.State.Status : 'missing',
    sidecar: s ? s.State.Status : 'missing',
    running: !!(c?.State.Running && s?.State.Running),
  };
}

export async function createPod({ id, timezone, language, proxyServer }: PodSpec): Promise<PodStatus> {
  const n = names(id);
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
    await docker.create(n.sidecar, {
      Image: config.sidecarImage,
      Labels: labels(id),
      Env: [
        `ACCOUNT_ID=${id}`,
        `REDIS_URL=${config.redisUrl}`,
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
  return status(id);
}

export async function deletePod(id: string, wipe: boolean) {
  const n = names(id);
  await removeContainer(n.sidecar);
  await removeContainer(n.chrome);
  if (wipe) await docker.removeVolume(n.profile);
  return { id, deleted: true, wiped: wipe };
}

export async function restartPod(id: string) {
  const n = names(id);
  for (const name of [n.chrome, n.sidecar]) if (await inspect(name)) await docker.restart(name, 5);
  return status(id);
}

/** Recreate containers (e.g. after an image update) but keep the profile volume = keep the LinkedIn session. */
export async function recreatePod(spec: PodSpec) {
  await deletePod(spec.id, false);
  return createPod(spec);
}

export async function listPods() {
  const list = await docker.listByLabel('linkedin-console.pod');
  const ids = [...new Set(list.map((c) => c.Labels['linkedin-console.pod']))];
  return Promise.all(ids.map(status));
}
