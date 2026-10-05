// pod-agent: creates/starts/stops/deletes "account pods" through the Docker API.
// A pod = `pod-<id>` (Chrome, joins the app network) + `pod-<id>-sidecar`
// (Live View + bridge, shares Chrome's network namespace so CDP stays on 127.0.0.1).
// Only reachable on the internal Docker network; every call needs POD_AGENT_TOKEN.
import http from 'node:http';
import Docker from 'dockerode';

const env = process.env;
const TOKEN = env.POD_AGENT_TOKEN;
if (!TOKEN) throw new Error('POD_AGENT_TOKEN is required');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const NETWORK = env.POD_NETWORK ?? 'linkunify';
const FILES_VOLUME = env.FILES_VOLUME ?? 'linkunify_files';
const CHROME_IMAGE = env.CHROME_IMAGE ?? 'linkunify/chrome:latest';
const SIDECAR_IMAGE = env.SIDECAR_IMAGE ?? 'linkunify/sidecar:latest';
const MEMORY = Number(env.POD_MEMORY_MB ?? 2048) * 1024 * 1024;
const EXTRA_SIDECAR_ENV = (env.SIDECAR_ENV ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// Self-healing settings forwarded to every sidecar (see apps/sidecar/src/bridge/heal.mjs).
const HEAL_ENV = ['HEAL_PROVIDER', 'HEAL_MODEL', 'ANTHROPIC_API_KEY', 'OLLAMA_URL'].filter((k) => env[k]).map((k) => `${k}=${env[k]}`);

const ID_RE = /^[a-z0-9]{12}$/;
const names = (id) => ({ chrome: `pod-${id}`, sidecar: `pod-${id}-sidecar`, profile: `linkunify_profile_${id}` });
const labels = (id) => ({ 'linkunify.pod': id });

async function find(name) {
  try { return await docker.getContainer(name).inspect(); } catch (e) { if (e.statusCode === 404) return null; throw e; }
}

async function ensureStarted(name) {
  const info = await find(name);
  if (info && !info.State.Running) await docker.getContainer(name).start();
}

async function createPod({ id, timezone, language, proxyServer }) {
  const n = names(id);
  // Chrome can't hold proxy credentials: if the proxy needs a login, Chrome talks to a
  // local forwarder in the sidecar (127.0.0.1:3128) which adds the credentials.
  const needsForwarder = /^https?:\/\/[^/]*@/.test(proxyServer ?? '');
  const chromeProxy = needsForwarder ? 'http://127.0.0.1:3128' : (proxyServer ?? '');
  if (!(await find(n.chrome))) {
    await docker.createVolume({ Name: n.profile, Labels: labels(id) }).catch((e) => { if (e.statusCode !== 409) throw e; });
    await docker.createContainer({
      name: n.chrome,
      Image: CHROME_IMAGE,
      Labels: labels(id),
      Env: [`TZ=${timezone}`, `CHROME_LANG=${language}`, `PROXY_SERVER=${chromeProxy}`, 'SCREEN_W=1440', 'SCREEN_H=900'],
      HostConfig: {
        Binds: [`${n.profile}:/data/profile`, `${FILES_VOLUME}:/data/files`],
        ShmSize: 2 * 1024 * 1024 * 1024,
        Memory: MEMORY,
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: NETWORK,
      },
      NetworkingConfig: { EndpointsConfig: { [NETWORK]: { Aliases: [n.chrome] } } },
    });
  }
  await ensureStarted(n.chrome);

  if (!(await find(n.sidecar))) {
    await docker.createContainer({
      name: n.sidecar,
      Image: SIDECAR_IMAGE,
      Labels: labels(id),
      Env: [`ACCOUNT_ID=${id}`, `REDIS_URL=${env.REDIS_URL}`, 'FILES_DIR=/data/files', `TZ=${timezone}`, `LIVE_SECRET=${env.LIVE_SECRET}`, `UPSTREAM_PROXY=${needsForwarder ? proxyServer : ''}`, ...HEAL_ENV, ...EXTRA_SIDECAR_ENV],
      HostConfig: {
        Binds: [`${FILES_VOLUME}:/data/files`],
        NetworkMode: `container:${n.chrome}`,
        RestartPolicy: { Name: 'unless-stopped' },
        Memory: 512 * 1024 * 1024,
      },
    });
  }
  await ensureStarted(n.sidecar);
  return status(id);
}

async function removeContainer(name) {
  const info = await find(name);
  if (info) await docker.getContainer(name).remove({ force: true });
}

async function deletePod(id, wipe) {
  const n = names(id);
  await removeContainer(n.sidecar);
  await removeContainer(n.chrome);
  if (wipe) await docker.getVolume(n.profile).remove().catch((e) => { if (e.statusCode !== 404) throw e; });
  return { id, deleted: true, wiped: !!wipe };
}

async function restartPod(id) {
  const n = names(id);
  for (const name of [n.chrome, n.sidecar]) if (await find(name)) await docker.getContainer(name).restart({ t: 5 });
  return status(id);
}

// Recreate containers (e.g. after an image update) but keep the profile volume = keep the LinkedIn session.
async function recreatePod(params) {
  await deletePod(params.id, false);
  return createPod(params);
}

async function status(id) {
  const n = names(id);
  const [c, s] = await Promise.all([find(n.chrome), find(n.sidecar)]);
  return {
    id,
    chrome: c ? c.State.Status : 'missing',
    sidecar: s ? s.State.Status : 'missing',
    running: !!(c?.State.Running && s?.State.Running),
  };
}

async function listPods() {
  const list = await docker.listContainers({ all: true, filters: { label: ['linkunify.pod'] } });
  const ids = [...new Set(list.map((c) => c.Labels['linkunify.pod']))];
  return Promise.all(ids.map(status));
}

// ---------- HTTP ----------
function send(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function podParams(id, body) {
  const timezone = String(body.timezone ?? 'UTC');
  const language = String(body.language ?? 'en-US');
  if (!/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/.test(timezone)) throw Object.assign(new Error('bad timezone'), { code: 400 });
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(language)) throw Object.assign(new Error('bad language'), { code: 400 });
  const proxyServer = body.proxyServer ? String(body.proxyServer) : '';
  if (proxyServer && !/^(https?|socks5?):\/\/[^\s'"]+$/.test(proxyServer)) throw Object.assign(new Error('bad proxy'), { code: 400 });
  return { id, timezone, language, proxyServer };
}

http.createServer(async (req, res) => {
  try {
    if (req.url === '/health') return send(res, 200, { ok: true });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'unauthorized' });

    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/pods(?:\/([a-z0-9]+))?(?:\/(restart|recreate))?$/);
    if (!m) return send(res, 404, { error: 'not found' });
    const [, id, action] = m;
    if (id && !ID_RE.test(id)) return send(res, 400, { error: 'bad id' });

    if (!id && req.method === 'GET') return send(res, 200, await listPods());
    if (id && !action && req.method === 'GET') return send(res, 200, await status(id));
    if (id && !action && req.method === 'PUT') return send(res, 200, await createPod(podParams(id, await readJson(req))));
    if (id && !action && req.method === 'DELETE') return send(res, 200, await deletePod(id, url.searchParams.get('wipe') === '1'));
    if (id && action === 'restart' && req.method === 'POST') return send(res, 200, await restartPod(id));
    if (id && action === 'recreate' && req.method === 'POST') return send(res, 200, await recreatePod(podParams(id, await readJson(req))));
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    send(res, e.code === 400 ? 400 : 500, { error: e.message });
  }
}).listen(7070, () => console.log('pod-agent listening on :7070'));
