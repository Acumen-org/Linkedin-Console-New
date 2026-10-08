// Email alerts when a LinkedIn account needs a human (re-login, checkpoint) or its browser stops.
// Configure SMTP_URL (e.g. smtp://user:pass@smtp.example.com:587) and ALERT_FROM; disabled otherwise.
import nodemailer from 'nodemailer';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { redis } from '../lib/redis.ts';

const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;

const MESSAGES: Record<string, { subject: string; body: string }> = {
  NEEDS_ATTENTION: {
    subject: 'needs you to log in again',
    body: 'LinkedIn logged this account out or asked for a security check. Sending is paused until someone with full access logs in again through Live View.',
  },
  OFFLINE: {
    subject: 'browser is offline',
    body: "This account's browser stopped reporting. Messages won't sync until it's back. Try Accounts → Restart browser, or check the server.",
  },
};

export async function alertAccountStatus(accountId: string, status: string) {
  const msg = MESSAGES[status];
  if (!msg || !transport) return;
  // At most one email per account + status every 6 hours.
  if (!(await redis.set(`lu:alert:${accountId}:${status}`, '1', 'EX', 6 * 3600, 'NX'))) return;

  const [account] = await sql`SELECT id, label, owner_user_id FROM accounts WHERE id = ${accountId}`;
  if (!account) return;
  const recipients = await sql`
    SELECT DISTINCT u.email FROM users u
    LEFT JOIN account_grants g ON g.user_id = u.id AND g.account_id = ${accountId}
    WHERE u.disabled_at IS NULL AND (u.role <> 'MEMBER' OR u.id = ${account.ownerUserId} OR g.level = 'FULL')`;
  if (!recipients.length) return;

  const link = config.appUrl ? `${config.appUrl}/accounts/${accountId}/connect` : '';
  try {
    await transport.sendMail({
      from: config.alertFrom,
      to: recipients.map((r) => r.email).join(', '),
      subject: `LinkedIn Console: "${account.label}" ${msg.subject}`,
      text: `${msg.body}\n\n${link ? `Fix it here: ${link}\n` : ''}`,
    });
  } catch (e) {
    logger.error({ err: e }, 'alert email failed');
  }
}
