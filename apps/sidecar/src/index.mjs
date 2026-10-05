// Sidecar for one account pod: Live View + bridge (+ optional proxy forwarder).
import { waitForChrome } from './cdp.mjs';
import { startLiveView } from './liveview.mjs';
import { startProxyForwarder } from './proxy.mjs';
import { createStreams } from './bridge/streams.mjs';
import { startBridge } from './bridge/bridge.mjs';

const env = process.env;
const accountId = env.ACCOUNT_ID;
if (!accountId) throw new Error('ACCOUNT_ID is required');
if (!env.LIVE_SECRET) throw new Error('LIVE_SECRET is required');

const filesDir = env.FILES_DIR ?? '/data/files';
const state = { bridgeTargetId: null };

if (env.UPSTREAM_PROXY) startProxyForwarder(env.UPSTREAM_PROXY);

const version = await waitForChrome();
console.log(`[sidecar] ${accountId}: Chrome ${version.Browser}`);

startLiveView({ secret: env.LIVE_SECRET, filesDir, state });

const streams = createStreams({ redisUrl: env.REDIS_URL ?? 'redis://redis:6379', accountId });
await startBridge({ accountId, streams, state, filesDir, captureRaw: env.CAPTURE_RAW === '1' });

process.on('unhandledRejection', (e) => console.error('[sidecar] unhandled', e));
