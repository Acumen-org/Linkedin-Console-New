import { LEVELS } from '@linkedin-console/contracts';
import { z } from 'zod';

/** All server configuration, validated once at startup. */
const Env = z.object({
  PORT: z.coerce.number().int().default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().default('redis://redis:6379'),
  FILES_DIR: z.string().default('/data/files'),
  POD_AGENT_URL: z.string().default('http://pod-agent:7070'),
  POD_AGENT_TOKEN: z.string().default(''),
  COOKIE_SECURE: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
  // Access MEMBERs get automatically on new accounts / as new users. NONE = nothing until an admin grants it.
  DEFAULT_GRANT: z
    .string()
    .default('NONE')
    .transform((v) => v.toUpperCase())
    .pipe(z.enum(['NONE', ...LEVELS])),
  DEFAULT_TIMEZONE: z.string().default('America/Chicago'),
  DEFAULT_LANGUAGE: z.string().default('en-US'),
  DAILY_SEND_CAP: z.coerce.number().int().positive().default(80),
  // New chats (cold outreach) per account per day, within DAILY_SEND_CAP.
  NEW_CHAT_CAP: z.coerce.number().int().min(0).default(20),
  // Newly connected accounts start at RAMP_START sends/day and add RAMP_STEP per day up to their cap.
  SEND_RAMP: z.enum(['on', 'off']).default('on'),
  SEND_RAMP_START: z.coerce.number().int().positive().default(20),
  SEND_RAMP_STEP: z.coerce.number().int().positive().default(10),
  SMTP_URL: z.string().default(''),
  ALERT_FROM: z.string().default('LinkedIn Console <alerts@localhost>'),
  APP_URL: z
    .string()
    .default('')
    .transform((v) => v.replace(/\/$/, '')),
  // AI reply drafts (optional)
  AI_PROVIDER: z.enum(['', 'anthropic', 'ollama']).default(''),
  AI_MODEL: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  OLLAMA_URL: z.string().default('http://ollama:11434'),
  // Web push (optional; keys are generated and stored in the DB when empty)
  VAPID_SUBJECT: z.string().default('mailto:admin@localhost'),
  // Microsoft 365 sign-in (optional): an Entra ID app registration in the company tenant.
  MICROSOFT_TENANT_ID: z.union([z.literal(''), z.uuid('MICROSOFT_TENANT_ID must be the tenant ID (a GUID), not "common"')]).default(''),
  MICROSOFT_CLIENT_ID: z.string().default(''),
  MICROSOFT_CLIENT_SECRET: z.string().default(''),
  // Who may still sign in with a password: everyone, or only the owner (break-glass when Microsoft is on).
  PASSWORD_SIGNIN: z.enum(['on', 'owner']).default('on'),
  // Twilio console staff list (optional): provision members and disable leavers.
  TWILIO_CONSOLE_URL: z
    .string()
    .default('')
    .transform((v) => v.replace(/\/$/, '')),
  TWILIO_CONSOLE_API_KEY: z.string().default(''),
  STAFF_SYNC: z.enum(['off', 'disable', 'provision']).default('off'),
  STAFF_SYNC_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid configuration:\n${issues}`);
  process.exit(1);
}
const e = parsed.data;

const microsoftEnabled = !!(e.MICROSOFT_TENANT_ID && e.MICROSOFT_CLIENT_ID && e.MICROSOFT_CLIENT_SECRET);
const problems = [
  (e.MICROSOFT_TENANT_ID || e.MICROSOFT_CLIENT_ID || e.MICROSOFT_CLIENT_SECRET) && !microsoftEnabled
    ? 'Microsoft sign-in needs MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET'
    : '',
  microsoftEnabled && !e.APP_URL ? 'Microsoft sign-in needs APP_URL (the public https:// address, for the redirect URI)' : '',
  e.PASSWORD_SIGNIN === 'owner' && !microsoftEnabled ? 'PASSWORD_SIGNIN=owner needs Microsoft sign-in configured' : '',
  e.STAFF_SYNC !== 'off' && !(e.TWILIO_CONSOLE_URL && e.TWILIO_CONSOLE_API_KEY)
    ? 'STAFF_SYNC needs TWILIO_CONSOLE_URL and TWILIO_CONSOLE_API_KEY'
    : '',
  e.STAFF_SYNC === 'provision' && !microsoftEnabled
    ? 'STAFF_SYNC=provision needs Microsoft sign-in (provisioned members have no password)'
    : '',
].filter(Boolean);
if (problems.length) {
  console.error(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}

export const config = {
  port: e.PORT,
  logLevel: e.LOG_LEVEL,
  databaseUrl: e.DATABASE_URL,
  redisUrl: e.REDIS_URL,
  filesDir: e.FILES_DIR,
  podAgentUrl: e.POD_AGENT_URL,
  podAgentToken: e.POD_AGENT_TOKEN,
  cookieSecure: e.COOKIE_SECURE,
  defaultGrant: e.DEFAULT_GRANT,
  defaultTimezone: e.DEFAULT_TIMEZONE,
  defaultLanguage: e.DEFAULT_LANGUAGE,
  dailySendCap: e.DAILY_SEND_CAP,
  newChatCap: e.NEW_CHAT_CAP,
  sendRamp: { on: e.SEND_RAMP === 'on', start: e.SEND_RAMP_START, step: e.SEND_RAMP_STEP },
  smtpUrl: e.SMTP_URL,
  alertFrom: e.ALERT_FROM,
  appUrl: e.APP_URL,
  ai: { provider: e.AI_PROVIDER, model: e.AI_MODEL, anthropicKey: e.ANTHROPIC_API_KEY, ollamaUrl: e.OLLAMA_URL },
  vapidSubject: e.VAPID_SUBJECT,
  microsoft: microsoftEnabled
    ? { tenantId: e.MICROSOFT_TENANT_ID, clientId: e.MICROSOFT_CLIENT_ID, clientSecret: e.MICROSOFT_CLIENT_SECRET }
    : null,
  passwordSignin: e.PASSWORD_SIGNIN,
  staffSync: {
    mode: e.STAFF_SYNC,
    url: e.TWILIO_CONSOLE_URL,
    apiKey: e.TWILIO_CONSOLE_API_KEY,
    minutes: e.STAFF_SYNC_MINUTES,
  },
} as const;
