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
  // Where the staff list comes from: the Twilio console, or the members of the Twenty CRM workspace.
  STAFF_SOURCE: z.enum(['twilio', 'twenty']).default('twilio'),
  // Twenty CRM (optional): GraphQL endpoint (https://…/graphql) and an API key (Settings → APIs in Twenty).
  TWENTY_API_URL: z.union([z.literal(''), z.url()]).default(''),
  TWENTY_API_KEY: z.string().default(''),
  // Twenty's web app (for "Open in Twenty"), when it isn't the API address without /graphql.
  TWENTY_WEB_URL: z.union([z.literal(''), z.url()]).default(''),
  // Person fields for the owner (a relation to a workspace member) and the pod (text or select).
  TWENTY_PERSON_OWNER_FIELD: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9]*$/)
    .default('assignedTo'),
  TWENTY_PERSON_POD_FIELD: z
    .string()
    .regex(/^[a-zA-Z][a-zA-Z0-9]*$/)
    .default('pod'),
  // Log prospects and their LinkedIn messages in Twenty (people + notes), from the moment this is switched on.
  CRM_SYNC: z.enum(['off', 'on']).default('off'),
  STAFF_SYNC_MINUTES: z.coerce.number().int().min(1).max(1440).default(5),
  // Restart account browsers that stop reporting or whose containers are gone (off for test stacks: their
  // accounts have no real browser).
  AUTO_RECOVERY: z.enum(['on', 'off']).default('on'),
  // Encrypts stored LinkedIn account passwords at rest (AES-256-GCM): a base64-encoded 32-byte key
  // (`openssl rand -base64 32`). Unset = storing a LinkedIn login, the Live-window password gate and
  // auto re-login stay off; everything else works as before.
  CREDENTIALS_KEY: z.string().default(''),
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
  e.STAFF_SYNC !== 'off' && e.STAFF_SOURCE === 'twilio' && !(e.TWILIO_CONSOLE_URL && e.TWILIO_CONSOLE_API_KEY)
    ? 'STAFF_SYNC needs TWILIO_CONSOLE_URL and TWILIO_CONSOLE_API_KEY'
    : '',
  e.STAFF_SYNC !== 'off' && e.STAFF_SOURCE === 'twenty' && !(e.TWENTY_API_URL && e.TWENTY_API_KEY)
    ? 'STAFF_SOURCE=twenty needs TWENTY_API_URL and TWENTY_API_KEY'
    : '',
  e.CRM_SYNC === 'on' && !(e.TWENTY_API_URL && e.TWENTY_API_KEY) ? 'CRM_SYNC=on needs TWENTY_API_URL and TWENTY_API_KEY' : '',
  !!e.TWENTY_API_URL !== !!e.TWENTY_API_KEY ? 'Twenty CRM needs both TWENTY_API_URL and TWENTY_API_KEY' : '',
  e.STAFF_SYNC === 'provision' && !microsoftEnabled
    ? 'STAFF_SYNC=provision needs Microsoft sign-in (provisioned members have no password)'
    : '',
  e.CREDENTIALS_KEY && Buffer.from(e.CREDENTIALS_KEY, 'base64').length !== 32
    ? 'CREDENTIALS_KEY must be a base64-encoded 32-byte key (generate one with `openssl rand -base64 32`)'
    : '',
].filter(Boolean);
if (problems.length) {
  console.error(`Invalid configuration:\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}

const webUrlFrom = (apiUrl: string, webUrl: string) => (webUrl || apiUrl.replace(/\/graphql\/?$/, '')).replace(/\/$/, '');

export type TwentyConn = { url: string; apiKey: string; webUrl: string; ownerField: string; podField: string };
export type MicrosoftConn = { tenantId: string; clientId: string; clientSecret: string };
export type StaffSyncConn = {
  mode: 'off' | 'disable' | 'provision';
  source: 'twilio' | 'twenty';
  url: string;
  apiKey: string;
  minutes: number;
};

/** The Twenty/staff/Microsoft integration config can be managed from the admin UI (stored in the DB and loaded by
 * lib/integrations.ts); whatever it sets overrides the env defaults below. Env stays the fallback, so nothing
 * changes until an admin edits it. */
export interface IntegrationOverrides {
  crmSync?: boolean;
  twenty?: TwentyConn | null;
  microsoft?: MicrosoftConn | null;
  staffSync?: Partial<Pick<StaffSyncConn, 'mode' | 'source' | 'url' | 'apiKey'>>;
}

const envMicrosoft: MicrosoftConn | null = microsoftEnabled
  ? { tenantId: e.MICROSOFT_TENANT_ID, clientId: e.MICROSOFT_CLIENT_ID, clientSecret: e.MICROSOFT_CLIENT_SECRET }
  : null;
const envTwenty: TwentyConn | null =
  e.TWENTY_API_URL && e.TWENTY_API_KEY
    ? {
        url: e.TWENTY_API_URL,
        apiKey: e.TWENTY_API_KEY,
        webUrl: webUrlFrom(e.TWENTY_API_URL, e.TWENTY_WEB_URL),
        ownerField: e.TWENTY_PERSON_OWNER_FIELD,
        podField: e.TWENTY_PERSON_POD_FIELD,
      }
    : null;
const envCrmSync = e.CRM_SYNC === 'on';
const envStaff: StaffSyncConn = {
  mode: e.STAFF_SYNC,
  source: e.STAFF_SOURCE,
  url: e.TWILIO_CONSOLE_URL,
  apiKey: e.TWILIO_CONSOLE_API_KEY,
  minutes: e.STAFF_SYNC_MINUTES,
};

let overrides: IntegrationOverrides = {};
/** Called by lib/integrations.ts after it reads the admin settings from the DB (and on each refresh). */
export function applyIntegrationOverrides(o: IntegrationOverrides) {
  overrides = o;
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
  passwordSignin: e.PASSWORD_SIGNIN,
  autoRecovery: e.AUTO_RECOVERY === 'on',
  credentialsKey: e.CREDENTIALS_KEY ? Buffer.from(e.CREDENTIALS_KEY, 'base64') : null,
  // Integration config: env defaults, overridden live by the admin settings (lib/integrations.ts).
  get microsoft(): MicrosoftConn | null {
    return overrides.microsoft !== undefined ? overrides.microsoft : envMicrosoft;
  },
  get crmSync(): boolean {
    return overrides.crmSync ?? envCrmSync;
  },
  get twenty(): TwentyConn | null {
    return overrides.twenty !== undefined ? overrides.twenty : envTwenty;
  },
  get staffSync(): StaffSyncConn {
    return { ...envStaff, ...(overrides.staffSync ?? {}) };
  },
};
