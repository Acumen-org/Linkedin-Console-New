/** Sidecar configuration (set per pod by the pod-agent). */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export const config = {
  accountId: required('ACCOUNT_ID'),
  liveSecret: required('LIVE_SECRET'),
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',
  filesDir: process.env.FILES_DIR ?? '/data/files',
  cdpHttp: process.env.CDP_HTTP ?? 'http://127.0.0.1:9222',
  liveViewPort: Number(process.env.LIVEVIEW_PORT ?? 8090),
  jpegQuality: Number(process.env.JPEG_QUALITY ?? 70),
  upstreamProxy: process.env.UPSTREAM_PROXY ?? '',
  captureRaw: process.env.CAPTURE_RAW === '1',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
