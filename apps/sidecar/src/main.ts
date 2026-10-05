// Sidecar for one account pod: Live View + bridge (+ optional proxy forwarder).
import { startBridge } from './bridge/index.ts';
import { createStreams } from './bridge/streams.ts';
import { waitForChrome } from './cdp.ts';
import { config } from './config.ts';
import { type SharedState, startLiveView } from './liveview/server.ts';
import { logger } from './logger.ts';
import { startProxyForwarder } from './proxy.ts';

process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

if (config.upstreamProxy) startProxyForwarder(config.upstreamProxy);

const version = await waitForChrome();
logger.info({ chrome: version.Browser }, 'chrome ready');

const shared: SharedState = { bridgeTargetId: null, status: 'AWAITING_LOGIN' };
startLiveView(shared);
await startBridge(createStreams(config.redisUrl, config.accountId), shared);
