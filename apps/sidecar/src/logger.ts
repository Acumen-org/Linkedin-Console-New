import pino from 'pino';

/** Structured JSON logs, tagged with the account this pod belongs to. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'sidecar', accountId: process.env.ACCOUNT_ID },
});
