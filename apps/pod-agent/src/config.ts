const env = process.env;

function required(name: string) {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** Settings forwarded to every sidecar (self-healing, tab parking, send speed, logging). */
const FORWARDED_KEYS = ['HEAL_PROVIDER', 'HEAL_MODEL', 'ANTHROPIC_API_KEY', 'OLLAMA_URL', 'LOG_LEVEL', 'PARK_AFTER_MINUTES', 'SEND_MODE'];

export const config = {
  port: Number(env.PORT ?? 7070),
  token: required('POD_AGENT_TOKEN'),
  liveSecret: required('LIVE_SECRET'),
  network: env.POD_NETWORK ?? 'linkedin-console',
  filesVolume: env.FILES_VOLUME ?? 'linkedin-console_files',
  chromeImage: env.CHROME_IMAGE ?? 'linkedin-console/chrome:latest',
  sidecarImage: env.SIDECAR_IMAGE ?? 'linkedin-console/sidecar:latest',
  redisUrl: env.REDIS_URL ?? 'redis://redis:6379',
  podMemoryBytes: Number(env.POD_MEMORY_MB ?? 2048) * 1024 * 1024,
  sidecarEnv: [
    ...FORWARDED_KEYS.filter((k) => env[k]).map((k) => `${k}=${env[k]}`),
    ...(env.SIDECAR_ENV ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ],
};
