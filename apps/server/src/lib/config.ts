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
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Invalid configuration:\n${issues}`);
  process.exit(1);
}
const e = parsed.data;

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
  smtpUrl: e.SMTP_URL,
  alertFrom: e.ALERT_FROM,
  appUrl: e.APP_URL,
  ai: { provider: e.AI_PROVIDER, model: e.AI_MODEL, anthropicKey: e.ANTHROPIC_API_KEY, ollamaUrl: e.OLLAMA_URL },
  vapidSubject: e.VAPID_SUBJECT,
} as const;
