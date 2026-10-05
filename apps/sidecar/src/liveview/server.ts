// Live View: streams this pod's Chrome tab to authorized web viewers (CDP screencast)
// and forwards mouse/keyboard/paste/file-upload from whoever holds control.
//
// Reachable only through Caddy, which (1) checks the user's session + grant with the api and
// (2) adds X-LU-Secret. Requests without the secret are rejected, so other containers on the
// Docker network (including web pages in other pods) can't use it.
//
// Uses only the Page/Input/DOM CDP domains (never Runtime.enable), so it adds no automation
// fingerprint to the pages LinkedIn sees.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { activateTab, Cdp, type CdpTarget, listPages, newTab } from '../cdp.ts';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import { dispatchInput, type InputMessage, type ScreenMeta } from './input.ts';

const MAX_W = 1440;
const MAX_H = 900;
const CONTROL_IDLE_MS = 120_000;
/** Park the human-facing tabs after this long without viewers (saves hundreds of MB per account). */
const PARK_AFTER_MS = Number(process.env.PARK_AFTER_MINUTES ?? 10) * 60_000;

export interface SharedState {
  /** The bridge's own window, hidden from viewers. */
  bridgeTargetId: string | null;
  /** Login state reported by the bridge; tabs are only parked when CONNECTED. */
  status: string;
}

interface Viewer {
  id: string;
  user: string;
  canControl: boolean;
}

type ClientMessage = InputMessage | { t: 'take' } | { t: 'release' } | { t: 'switch'; id: string } | { t: 'newtab' };

export function startLiveView(state: SharedState) {
  const indexHtml = fs.readFile(new URL('../../public/index.html', import.meta.url), 'utf8');
  const viewers = new Map<WebSocket, Viewer>();
  let cdp: Cdp | null = null;
  let current: { id: string; url: string; title: string } | null = null;
  let meta: ScreenMeta | null = null;
  let lastFrame: string | null = null;
  let fileChooser: { backendNodeId: number; mode: string } | null = null;
  let controller: { id: string; user: string; at: number } | null = null;
  let lastViewerAt = Date.now();
  /** Tabs put to sleep while nobody watches: tab id → the URL to restore. */
  const parked = new Map<string, string>();

  const send = (ws: WebSocket, obj: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
  const broadcast = (obj: unknown) => {
    const s = JSON.stringify(obj);
    for (const ws of viewers.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(s);
  };
  const visibleTabs = async () => (await listPages()).filter((t) => t.id !== state.bridgeTargetId);
  const tabSummary = (tabs: CdpTarget[]) => tabs.map(({ id, title, url }) => ({ id, title, url }));
  const controlInfo = () => ({ t: 'control', user: controller?.user ?? null, id: controller?.id ?? null });

  async function attach(targetId?: string) {
    let tabs = await visibleTabs();
    if (!tabs.length) {
      await newTab();
      tabs = await visibleTabs();
    }
    const tab = tabs.find((t) => t.id === targetId) ?? tabs[0];
    cdp?.close();
    await activateTab(tab.id);
    const session = new Cdp(tab.webSocketDebuggerUrl);
    cdp = session;
    await session.ready;
    current = { id: tab.id, url: tab.url, title: tab.title };
    const restoreUrl = parked.get(tab.id);
    if (restoreUrl) {
      parked.delete(tab.id);
      if (tab.url === 'about:blank') {
        await session.send('Page.navigate', { url: restoreUrl }).catch(() => {});
        current.url = restoreUrl;
      }
    }

    session.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      meta = metadata;
      lastFrame = data;
      broadcast({ t: 'frame', data });
      session.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    session.on('Page.frameNavigated', ({ frame }) => {
      if (!frame.parentId && current) {
        current.url = frame.url;
        broadcast({ t: 'nav', url: frame.url });
      }
    });
    session.on('Page.fileChooserOpened', ({ backendNodeId, mode }) => {
      fileChooser = { backendNodeId, mode };
      broadcast({ t: 'filechooser', mode });
    });
    session.onClose = () =>
      setTimeout(() => {
        if (viewers.size) attach().catch(() => {});
      }, 1000);

    await session.send('Page.enable');
    await session.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: config.jpegQuality,
      maxWidth: MAX_W,
      maxHeight: MAX_H,
      everyNthFrame: 1,
    });
    // Screencast only emits on repaint; send one snapshot so static pages aren't blank.
    const [{ cssLayoutViewport: vp }, shot] = await Promise.all([
      session.send('Page.getLayoutMetrics'),
      session.send('Page.captureScreenshot', { format: 'jpeg', quality: config.jpegQuality }),
    ]);
    meta = { deviceWidth: vp.clientWidth, deviceHeight: vp.clientHeight };
    lastFrame = shot.data;
    broadcast({ t: 'frame', data: lastFrame });
    broadcast({ t: 'tab', ...current, tabs: tabSummary(await visibleTabs()) });
  }

  /** Nobody watching for a while and the account is connected: unload the human tabs (the bridge's own window keeps syncing). */
  async function parkIdleTabs() {
    if (viewers.size || state.status !== 'CONNECTED' || Date.now() - lastViewerAt < PARK_AFTER_MS) return;
    for (const tab of await visibleTabs()) {
      if (parked.has(tab.id) || tab.url === 'about:blank' || !tab.url.startsWith('http')) continue;
      const session = new Cdp(tab.webSocketDebuggerUrl);
      try {
        await session.ready;
        await session.send('Page.navigate', { url: 'about:blank' });
        parked.set(tab.id, tab.url);
        logger.info({ url: tab.url }, 'parked idle tab');
      } catch (err) {
        logger.warn({ err }, 'could not park tab');
      } finally {
        session.close();
      }
    }
  }
  setInterval(() => parkIdleTabs().catch(() => {}), 60_000);

  async function detachIfIdle() {
    if (viewers.size || !cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => {});
    cdp.close();
    cdp = null;
  }

  setInterval(async () => {
    if (!viewers.size) return;
    if (controller && Date.now() - controller.at > CONTROL_IDLE_MS) {
      controller = null;
      broadcast(controlInfo());
    }
    try {
      broadcast({ t: 'tabs', tabs: tabSummary(await visibleTabs()) });
    } catch {}
  }, 2000);

  async function handleControlled(msg: ClientMessage) {
    if (!cdp) return;
    if (msg.t === 'switch') return attach(String(msg.id));
    if (msg.t === 'newtab') return attach((await newTab()).id);
    if (msg.t === 'file') {
      if (!fileChooser) return;
      const dir = path.join(config.filesDir, 'live');
      await fs.mkdir(dir, { recursive: true });
      const safe = path
        .basename(String(msg.name))
        .replace(/[^\w.-]/g, '_')
        .slice(0, 120);
      const file = path.join(dir, `${crypto.randomUUID()}-${safe}`);
      await fs.writeFile(file, Buffer.from(String(msg.data), 'base64'));
      await cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId: fileChooser.backendNodeId });
      fileChooser = null;
      setTimeout(() => fs.rm(file, { force: true }), 10 * 60_000);
      return;
    }
    if (msg.t === 'take' || msg.t === 'release') return;
    return dispatchInput(cdp, msg, meta ?? { deviceWidth: MAX_W, deviceHeight: MAX_H });
  }

  // ---------- HTTP + WS ----------
  const fromCaddy = (req: http.IncomingMessage) => req.headers['x-lu-secret'] === config.liveSecret;

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    if (pathname === '/health') return res.end('ok');
    if (!fromCaddy(req)) {
      res.statusCode = 403;
      return res.end('forbidden');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(await indexHtml);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 25 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', 'http://x');
    if (!pathname.endsWith('/ws') || !fromCaddy(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (ws: WebSocket, req: http.IncomingMessage) => {
    const viewer: Viewer = {
      id: crypto.randomUUID(),
      user: decodeURIComponent(String(req.headers['x-lu-user'] ?? 'Someone')),
      canControl: req.headers['x-lu-control'] === '1',
    };
    viewers.set(ws, viewer);
    lastViewerAt = Date.now();
    send(ws, { t: 'hello', id: viewer.id, canControl: viewer.canControl });

    ws.on('close', () => {
      viewers.delete(ws);
      lastViewerAt = Date.now();
      if (controller?.id === viewer.id) {
        controller = null;
        broadcast(controlInfo());
      }
      setTimeout(detachIfIdle, 5000);
    });

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === 'take') {
        if (!viewer.canControl) return;
        controller = { id: viewer.id, user: viewer.user, at: Date.now() };
        return broadcast(controlInfo());
      }
      if (msg.t === 'release') {
        if (controller?.id === viewer.id) {
          controller = null;
          broadcast(controlInfo());
        }
        return;
      }
      if (!viewer.canControl) return;
      // First person to interact while nobody holds control gets it automatically.
      if (!controller) {
        controller = { id: viewer.id, user: viewer.user, at: Date.now() };
        broadcast(controlInfo());
      }
      if (controller.id !== viewer.id) return send(ws, { t: 'error', message: `${controller.user} is in control` });
      controller.at = Date.now();
      handleControlled(msg).catch((e: Error) => send(ws, { t: 'error', message: e.message }));
    });

    try {
      if (!cdp) await attach();
      send(ws, { t: 'tab', ...current, tabs: tabSummary(await visibleTabs()) });
      send(ws, controlInfo());
      if (lastFrame) send(ws, { t: 'frame', data: lastFrame });
    } catch (e) {
      send(ws, { t: 'error', message: (e as Error).message });
    }
  });

  server.listen(config.liveViewPort, () => logger.info({ port: config.liveViewPort }, 'live view listening'));
  return server;
}
