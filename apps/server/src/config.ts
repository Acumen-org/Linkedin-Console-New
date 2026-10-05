const env = process.env;

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export type Level = 'READ' | 'REPLY' | 'FULL';
const grant = (env.DEFAULT_GRANT ?? 'REPLY').toUpperCase();

export const config = {
  port: Number(env.PORT ?? 4000),
  databaseUrl: required('DATABASE_URL'),
  redisUrl: env.REDIS_URL ?? 'redis://redis:6379',
  filesDir: env.FILES_DIR ?? '/data/files',
  podAgentUrl: env.POD_AGENT_URL ?? 'http://pod-agent:7070',
  podAgentToken: env.POD_AGENT_TOKEN ?? '',
  cookieSecure: env.COOKIE_SECURE !== 'false',
  defaultGrant: (['READ', 'REPLY', 'FULL'].includes(grant) ? grant : 'REPLY') as Level,
  defaultTimezone: env.DEFAULT_TIMEZONE ?? 'America/Chicago',
  defaultLanguage: env.DEFAULT_LANGUAGE ?? 'en-US',
  dailySendCap: Number(env.DAILY_SEND_CAP ?? 80),
  smtpUrl: env.SMTP_URL ?? '',
  alertFrom: env.ALERT_FROM ?? 'LinkUnify <alerts@localhost>',
  appUrl: (env.APP_URL ?? '').replace(/\/$/, ''),
};
