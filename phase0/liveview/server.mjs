// Live View: streams the real Chrome tab to any number of web viewers using the
// CDP screencast, and forwards mouse/keyboard/paste/file-upload back to Chrome.
// No VNC, no WebRTC, no UDP: just HTTPS + WebSocket (works behind any reverse proxy).
//
// Uses raw CDP with only the Page/Input/DOM domains, never Runtime.enable,
// so it adds no automation fingerprint to the LinkedIn page.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8090);
const CDP_HTTP = process.env.CDP_HTTP ?? 'http://127.0.0.1:9222';
const TOKEN = process.env.LIVEVIEW_TOKEN;
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/data/uploads';
const MAX_W = Number(process.env.MAX_W ?? 1440);
const MAX_H = Number(process.env.MAX_H ?? 900);
const QUALITY = Number(process.env.JPEG_QUALITY ?? 70);

if (!TOKEN) throw new Error('LIVEVIEW_TOKEN is required');

const indexHtml = await fs.readFile(new URL('./public/index.html', import.meta.url), 'utf8');

// ---------- minimal CDP client ----------
class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        this.handlers.get(msg.method)?.(msg.params);
      }
    });
    this.ws.on('close', () => this.onClose?.());
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  on(method, fn) { this.handlers.set(method, fn); }
  close() { try { this.ws.close(); } catch {} }
}

async function listTabs() {
  const r = await fetch(`${CDP_HTTP}/json/list`);
  return (await r.json()).filter((t) => t.type === 'page' && !t.url.startsWith('devtools://'));
}

// ---------- shared screen hub (all viewers see the same tab) ----------
const viewers = new Set();
let cdp = null;
let current = null;        // { id, url, title }
let lastMeta = null;       // screencast metadata (device size in CSS px)
let lastFrame = null;
let fileChooser = null;    // { backendNodeId, mode }

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const v of viewers) if (v.readyState === WebSocket.OPEN) v.send(s);
}

async function attach(targetId) {
  const tabs = await listTabs();
  const tab = tabs.find((t) => t.id === targetId) ?? tabs[0];
  if (!tab) throw new Error('No tabs open in Chrome');
  if (cdp) { cdp.onClose = null; cdp.close(); }

  await fetch(`${CDP_HTTP}/json/activate/${tab.id}`); // bring to front so it renders
  cdp = new Cdp(tab.webSocketDebuggerUrl);
  await cdp.ready;
  current = { id: tab.id, url: tab.url, title: tab.title };

  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    lastMeta = metadata;
    lastFrame = data;
    broadcast({ t: 'frame', data, w: metadata.deviceWidth, h: metadata.deviceHeight });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  cdp.on('Page.frameNavigated', ({ frame }) => {
    if (!frame.parentId) { current.url = frame.url; broadcast({ t: 'nav', url: frame.url }); }
  });
  cdp.on('Page.fileChooserOpened', ({ backendNodeId, mode }) => {
    fileChooser = { backendNodeId, mode };
    broadcast({ t: 'filechooser', mode });
  });
  cdp.onClose = () => setTimeout(() => attach().catch(() => {}), 1000); // tab closed → reattach

  await cdp.send('Page.enable');
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: MAX_W, maxHeight: MAX_H, everyNthFrame: 1 });
  // Screencast only emits on repaint, so a static page would stay blank. Send one snapshot now.
  const [{ cssLayoutViewport: vp }, shot] = await Promise.all([
    cdp.send('Page.getLayoutMetrics'),
    cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: QUALITY }),
  ]);
  lastMeta = { deviceWidth: vp.clientWidth, deviceHeight: vp.clientHeight };
  lastFrame = shot.data;
  broadcast({ t: 'frame', data: lastFrame, w: vp.clientWidth, h: vp.clientHeight });
  broadcast({ t: 'tab', ...current, tabs: (await listTabs()).map(({ id, title, url }) => ({ id, title, url })) });
}

// Keep viewers' tab list fresh (e.g. a "Sign in with Google" popup appears as a
// new tab). We don't auto-follow: the bridge also opens tabs, and viewers
// shouldn't be yanked onto them. The user picks the tab from the dropdown.
setInterval(async () => {
  if (!viewers.size) return;
  try {
    const tabs = await listTabs();
    broadcast({ t: 'tabs', tabs: tabs.map(({ id, title, url }) => ({ id, title, url })) });
  } catch {}
}, 2000);

// ---------- input mapping ----------
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const SPECIAL = {
  Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Delete: 46, Home: 36, End: 35,
  PageUp: 33, PageDown: 34, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
};
const mods = (m = {}) => Object.entries(MOD).reduce((a, [k, v]) => a | (m[k] ? v : 0), 0);
const toXY = (m) => ({ x: m.x * (lastMeta?.deviceWidth ?? MAX_W), y: m.y * (lastMeta?.deviceHeight ?? MAX_H) });

async function handle(msg) {
  if (!cdp) return;
  switch (msg.t) {
    case 'mouse': {
      const { x, y } = toXY(msg);
      await cdp.send('Input.dispatchMouseEvent', {
        type: msg.type, x, y, button: msg.button ?? 'none', buttons: msg.buttons ?? 0,
        clickCount: msg.clickCount ?? 0, modifiers: mods(msg.mods),
      });
      break;
    }
    case 'wheel': {
      const { x, y } = toXY(msg);
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: msg.dx, deltaY: msg.dy });
      break;
    }
    case 'key': {
      const m = mods(msg.mods);
      const code = SPECIAL[msg.key];
      const printable = msg.key.length === 1 && !(m & (MOD.ctrl | MOD.meta));
      const text = printable ? msg.key : msg.key === 'Enter' ? '\r' : undefined;
      const vk = code ?? (msg.key.length === 1 ? msg.key.toUpperCase().charCodeAt(0) : 0);
      await cdp.send('Input.dispatchKeyEvent', {
        type: text ? 'keyDown' : 'rawKeyDown', key: msg.key, code: msg.code,
        windowsVirtualKeyCode: vk, modifiers: m, ...(text ? { text } : {}),
      });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: msg.key, code: msg.code, windowsVirtualKeyCode: vk, modifiers: m });
      break;
    }
    case 'paste':
      await cdp.send('Input.insertText', { text: String(msg.text).slice(0, 10_000) });
      break;
    case 'navigate': {
      let url = String(msg.url).trim();
      if (!/^https?:\/\//.test(url)) url = `https://${url}`;
      await cdp.send('Page.navigate', { url });
      break;
    }
    case 'back': {
      const h = await cdp.send('Page.getNavigationHistory');
      if (h.currentIndex > 0) await cdp.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
      break;
    }
    case 'reload':
      await cdp.send('Page.reload');
      break;
    case 'switch':
      await attach(msg.id);
      break;
    case 'file': {
      if (!fileChooser) return;
      await fs.mkdir(UPLOAD_DIR, { recursive: true });
      const safe = path.basename(String(msg.name)).replace(/[^\w.\-]/g, '_');
      const file = path.join(UPLOAD_DIR, `${crypto.randomUUID()}-${safe}`);
      await fs.writeFile(file, Buffer.from(msg.data, 'base64'));
      await cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId: fileChooser.backendNodeId });
      fileChooser = null;
      break;
    }
  }
}

// ---------- HTTP + WS ----------
const authed = (req) => new URL(req.url, 'http://x').searchParams.get('token') === TOKEN;

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/health') return res.end('ok');
  if (pathname !== '/' || !authed(req)) { res.statusCode = 401; return res.end('unauthorized'); }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(indexHtml);
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 25 * 1024 * 1024 });
wss.on('connection', async (ws, req) => {
  if (!authed(req)) return ws.close(4401, 'unauthorized');
  viewers.add(ws);
  ws.on('close', () => viewers.delete(ws));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handle(msg).catch((e) => ws.send(JSON.stringify({ t: 'error', message: e.message })));
  });
  try {
    if (!cdp) await attach();
    ws.send(JSON.stringify({ t: 'tab', ...current, tabs: (await listTabs()).map(({ id, title, url }) => ({ id, title, url })) }));
    if (lastFrame) ws.send(JSON.stringify({ t: 'frame', data: lastFrame, w: lastMeta.deviceWidth, h: lastMeta.deviceHeight }));
  } catch (e) {
    ws.send(JSON.stringify({ t: 'error', message: e.message }));
  }
});

server.listen(PORT, () => console.log(`Live View on :${PORT}`));
