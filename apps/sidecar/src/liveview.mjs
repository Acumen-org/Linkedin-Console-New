// Live View: streams this pod's Chrome tab to authorized web viewers (CDP screencast)
// and forwards mouse/keyboard/paste/file-upload from whoever holds control.
//
// Reachable only through Caddy, which (1) checks the user's session + grant with the api
// and (2) adds X-LU-Secret. Requests without the secret are rejected, so other
// containers on the Docker network (including web pages in other pods) can't use it.
//
// Uses only the Page/Input/DOM CDP domains (never Runtime.enable), so it adds no
// automation fingerprint to the pages LinkedIn sees.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Cdp, listPages, newTab, activateTab } from './cdp.mjs';

const MAX_W = 1440;
const MAX_H = 900;
const QUALITY = Number(process.env.JPEG_QUALITY ?? 70);
const CONTROL_IDLE_MS = 120_000;

export function startLiveView({ port = 8090, secret, filesDir, state }) {
  const indexHtml = fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const viewers = new Map(); // ws → { id, user, canControl }
  let cdp = null;
  let current = null;
  let meta = null;
  let lastFrame = null;
  let fileChooser = null;
  let controller = null; // { id, user, at }

  const send = (ws, obj) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
  const broadcast = (obj) => { const s = JSON.stringify(obj); for (const ws of viewers.keys()) if (ws.readyState === WebSocket.OPEN) ws.send(s); };

  async function visibleTabs() {
    return (await listPages()).filter((t) => t.id !== state.bridgeTargetId);
  }
  const tabSummary = (tabs) => tabs.map(({ id, title, url }) => ({ id, title, url }));
  const controlInfo = () => ({ t: 'control', user: controller?.user ?? null, id: controller?.id ?? null });

  async function attach(targetId) {
    let tabs = await visibleTabs();
    if (!tabs.length) { await newTab(); tabs = await visibleTabs(); }
    const tab = tabs.find((t) => t.id === targetId) ?? tabs[0];
    if (cdp) cdp.close();
    await activateTab(tab.id);
    cdp = new Cdp(tab.webSocketDebuggerUrl);
    await cdp.ready;
    current = { id: tab.id, url: tab.url, title: tab.title };

    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      meta = metadata;
      lastFrame = data;
      broadcast({ t: 'frame', data });
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    });
    cdp.on('Page.frameNavigated', ({ frame }) => {
      if (!frame.parentId) { current.url = frame.url; broadcast({ t: 'nav', url: frame.url }); }
    });
    cdp.on('Page.fileChooserOpened', ({ backendNodeId, mode }) => {
      fileChooser = { backendNodeId, mode };
      broadcast({ t: 'filechooser', mode });
    });
    cdp.onClose = () => setTimeout(() => { if (viewers.size) attach().catch(() => {}); }, 1000);

    await cdp.send('Page.enable');
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: MAX_W, maxHeight: MAX_H, everyNthFrame: 1 });
    // Screencast only emits on repaint; send one snapshot so static pages aren't blank.
    const [{ cssLayoutViewport: vp }, shot] = await Promise.all([
      cdp.send('Page.getLayoutMetrics'),
      cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY }),
    ]);
    meta = { deviceWidth: vp.clientWidth, deviceHeight: vp.clientHeight };
    lastFrame = shot.data;
    broadcast({ t: 'frame', data: lastFrame });
    broadcast({ t: 'tab', ...current, tabs: tabSummary(await visibleTabs()) });
  }

  async function detachIfIdle() {
    if (viewers.size || !cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => {});
    cdp.close();
    cdp = null;
  }

  setInterval(async () => {
    if (!viewers.size) return;
    if (controller && Date.now() - controller.at > CONTROL_IDLE_MS) { controller = null; broadcast(controlInfo()); }
    try { broadcast({ t: 'tabs', tabs: tabSummary(await visibleTabs()) }); } catch {}
  }, 2000);

  // ---------- input ----------
  const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const SPECIAL = {
    Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, Home: 36, End: 35,
    PageUp: 33, PageDown: 34, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  };
  const mods = (m = {}) => Object.entries(MOD).reduce((a, [k, v]) => a | (m[k] ? v : 0), 0);
  const xy = (m) => ({
    x: Math.max(0, Math.min(1, Number(m.x))) * (meta?.deviceWidth ?? MAX_W),
    y: Math.max(0, Math.min(1, Number(m.y))) * (meta?.deviceHeight ?? MAX_H),
  });

  async function handleInput(v, msg) {
    if (!cdp) return;
    switch (msg.t) {
      case 'mouse':
        return cdp.send('Input.dispatchMouseEvent', {
          type: msg.type, ...xy(msg), button: msg.button ?? 'none', buttons: msg.buttons ?? 0,
          clickCount: msg.clickCount ?? 0, modifiers: mods(msg.mods),
        });
      case 'wheel':
        return cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...xy(msg), deltaX: Number(msg.dx) || 0, deltaY: Number(msg.dy) || 0 });
      case 'key': {
        const key = String(msg.key);
        const m = mods(msg.mods);
        const printable = key.length === 1 && !(m & (MOD.ctrl | MOD.meta));
        const text = printable ? key : key === 'Enter' ? '\r' : undefined;
        const vk = SPECIAL[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
        await cdp.send('Input.dispatchKeyEvent', {
          type: text ? 'keyDown' : 'rawKeyDown', key, code: msg.code, windowsVirtualKeyCode: vk, modifiers: m, ...(text ? { text } : {}),
        });
        return cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: msg.code, windowsVirtualKeyCode: vk, modifiers: m });
      }
      case 'paste':
        return cdp.send('Input.insertText', { text: String(msg.text).slice(0, 20_000) });
      case 'navigate': {
        let url = String(msg.url).trim();
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        return cdp.send('Page.navigate', { url });
      }
      case 'back': {
        const h = await cdp.send('Page.getNavigationHistory');
        if (h.currentIndex > 0) return cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
        return;
      }
      case 'reload':
        return cdp.send('Page.reload');
      case 'switch':
        return attach(String(msg.id));
      case 'newtab': {
        const t = await newTab();
        return attach(t.id);
      }
      case 'file': {
        if (!fileChooser) return;
        const dir = path.join(filesDir, 'live');
        await fs.mkdir(dir, { recursive: true });
        const safe = path.basename(String(msg.name)).replace(/[^\w.\-]/g, '_').slice(0, 120);
        const file = path.join(dir, `${crypto.randomUUID()}-${safe}`);
        await fs.writeFile(file, Buffer.from(String(msg.data), 'base64'));
        await cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId: fileChooser.backendNodeId });
        fileChooser = null;
        setTimeout(() => fs.rm(file, { force: true }), 10 * 60_000);
        return;
      }
    }
  }

  // ---------- HTTP + WS ----------
  const fromCaddy = (req) => secret && req.headers['x-lu-secret'] === secret;

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname === '/health') return res.end('ok');
    if (!fromCaddy(req)) { res.statusCode = 403; return res.end('forbidden'); }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(await indexHtml);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 25 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (!pathname.endsWith('/ws') || !fromCaddy(req)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', async (ws, req) => {
    const user = decodeURIComponent(String(req.headers['x-lu-user'] ?? 'Someone'));
    const canControl = req.headers['x-lu-control'] === '1';
    const v = { id: crypto.randomUUID(), user, canControl };
    viewers.set(ws, v);
    send(ws, { t: 'hello', id: v.id, canControl });

    ws.on('close', () => {
      viewers.delete(ws);
      if (controller?.id === v.id) { controller = null; broadcast(controlInfo()); }
      setTimeout(detachIfIdle, 5000);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.t === 'take') {
        if (!v.canControl) return;
        controller = { id: v.id, user: v.user, at: Date.now() };
        return broadcast(controlInfo());
      }
      if (msg.t === 'release') {
        if (controller?.id === v.id) { controller = null; broadcast(controlInfo()); }
        return;
      }
      if (!v.canControl) return;
      // First person to interact while nobody holds control gets it automatically.
      if (!controller) { controller = { id: v.id, user: v.user, at: Date.now() }; broadcast(controlInfo()); }
      if (controller.id !== v.id) return send(ws, { t: 'error', message: `${controller.user} is in control` });
      controller.at = Date.now();
      handleInput(v, msg).catch((e) => send(ws, { t: 'error', message: e.message }));
    });

    try {
      if (!cdp) await attach();
      send(ws, { t: 'tab', ...current, tabs: tabSummary(await visibleTabs()) });
      send(ws, controlInfo());
      if (lastFrame) send(ws, { t: 'frame', data: lastFrame });
    } catch (e) {
      send(ws, { t: 'error', message: e.message });
    }
  });

  server.listen(port, () => console.log(`[liveview] listening on :${port}`));
  return server;
}
