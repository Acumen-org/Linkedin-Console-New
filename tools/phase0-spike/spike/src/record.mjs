// Step 2: discovery. Open the messaging page in a bridge tab and record every
// LinkedIn JSON response + realtime event, so we can learn the current
// endpoints and payload shapes (these become the bridge adapter + test fixtures).
//
//   docker compose run --rm spike node src/record.mjs [seconds=120]
//
// While it runs, click through a few conversations in Neko or in the bridge tab.
import { attach, isLoggedOut, saveJson } from './lib.mjs';

const seconds = Number(process.argv[2] ?? 120);
const { browser, context } = await attach();
const page = await context.newPage();

const records = [];
const realtime = [];

page.on('response', async (res) => {
  const url = res.url();
  if (!url.includes('linkedin.com')) return;
  const type = res.headers()['content-type'] ?? '';
  if (!type.includes('json')) return;
  try {
    const body = await res.json();
    records.push({ at: new Date().toISOString(), method: res.request().method(), status: res.status(), url, body });
    console.log(`[json] ${res.status()} ${url.slice(0, 140)}`);
  } catch { /* streamed or empty body */ }
});

// Realtime: LinkedIn pushes live events to the open tab. Capture both
// Server-Sent Events and WebSocket frames, whichever is used today.
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
cdp.on('Network.eventSourceMessageReceived', (e) => {
  realtime.push({ at: new Date().toISOString(), kind: 'sse', event: e.eventName, data: e.data });
  console.log(`[sse] ${e.eventName} ${String(e.data).slice(0, 120)}`);
});
page.on('websocket', (ws) => {
  console.log(`[ws] open ${ws.url()}`);
  ws.on('framereceived', (f) => realtime.push({ at: new Date().toISOString(), kind: 'ws', url: ws.url(), data: String(f.payload) }));
});

await page.goto('https://www.linkedin.com/messaging/', { waitUntil: 'domcontentloaded' });
if (isLoggedOut(page.url())) {
  console.error('❌ Not logged in. Log in via Neko first.');
  process.exit(1);
}

console.log(`Recording for ${seconds}s… send yourself a message from another account to capture a live event.`);
await page.waitForTimeout(seconds * 1000);

const stamp = Date.now();
console.log('Saved:', await saveJson(`responses-${stamp}.json`, records));
console.log('Saved:', await saveJson(`realtime-${stamp}.json`, realtime));

// Quick summary: which endpoints carried data
const byPath = {};
for (const r of records) {
  const u = new URL(r.url);
  const key = `${r.method} ${u.pathname}${u.searchParams.get('queryId') ? `?queryId=${u.searchParams.get('queryId')}` : ''}`;
  byPath[key] = (byPath[key] ?? 0) + 1;
}
console.table(byPath);

await page.close();
await browser.close();
