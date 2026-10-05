// pod-agent: small authenticated HTTP API that creates/starts/stops/deletes account pods.
// Only reachable on the internal Docker network; every call needs POD_AGENT_TOKEN.
//
//   GET    /pods                 list
//   GET    /pods/:id             status
//   PUT    /pods/:id             create + start   { timezone, language, proxyServer }
//   POST   /pods/:id/restart
//   POST   /pods/:id/recreate    new containers, same profile (session kept)
//   DELETE /pods/:id[?wipe=1]    remove (wipe = also delete the browser profile)
import http from 'node:http';
import { ACCOUNT_ID_RE } from '@linkunify/contracts';
import { config } from './config.ts';
import { createPod, deletePod, listPods, type PodSpec, recreatePod, restartPod, status } from './pods.ts';

class BadRequest extends Error {}

function send(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function podSpec(id: string, body: Record<string, unknown>): PodSpec {
  const timezone = String(body.timezone ?? 'UTC');
  const language = String(body.language ?? 'en-US');
  const proxyServer = body.proxyServer ? String(body.proxyServer) : '';
  if (!/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/.test(timezone)) throw new BadRequest('bad timezone');
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(language)) throw new BadRequest('bad language');
  if (proxyServer && !/^(https?|socks5?):\/\/[^\s'"]+$/.test(proxyServer)) throw new BadRequest('bad proxy');
  return { id, timezone, language, proxyServer };
}

async function route(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url === '/health') return send(res, 200, { ok: true });
  if (req.headers.authorization !== `Bearer ${config.token}`) return send(res, 401, { error: 'unauthorized' });

  const url = new URL(req.url ?? '/', 'http://x');
  const m = url.pathname.match(/^\/pods(?:\/([a-z0-9]+))?(?:\/(restart|recreate))?$/);
  if (!m) return send(res, 404, { error: 'not found' });
  const [, id, action] = m;
  if (id && !ACCOUNT_ID_RE.test(id)) return send(res, 400, { error: 'bad id' });

  if (!id && req.method === 'GET') return send(res, 200, await listPods());
  if (!id) return send(res, 405, { error: 'method not allowed' });
  if (!action && req.method === 'GET') return send(res, 200, await status(id));
  if (!action && req.method === 'PUT') return send(res, 200, await createPod(podSpec(id, await readJson(req))));
  if (!action && req.method === 'DELETE') return send(res, 200, await deletePod(id, url.searchParams.get('wipe') === '1'));
  if (action === 'restart' && req.method === 'POST') return send(res, 200, await restartPod(id));
  if (action === 'recreate' && req.method === 'POST') return send(res, 200, await recreatePod(podSpec(id, await readJson(req))));
  return send(res, 405, { error: 'method not allowed' });
}

http
  .createServer((req, res) => {
    route(req, res).catch((e: Error) => {
      if (!(e instanceof BadRequest)) console.error(JSON.stringify({ level: 'error', msg: e.message, stack: e.stack }));
      send(res, e instanceof BadRequest ? 400 : 500, { error: e.message });
    });
  })
  .listen(config.port, () => console.log(JSON.stringify({ level: 'info', msg: `pod-agent listening on :${config.port}` })));
