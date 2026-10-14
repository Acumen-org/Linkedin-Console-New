// Email alerts when a LinkedIn account needs a human (re-login, checkpoint) or its browser stops.
// Configure SMTP_URL (e.g. smtp://user:pass@smtp.example.com:587) and ALERT_FROM; disabled otherwise.
import nodemailer from 'nodemailer';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { logger } from '../lib/logger.ts';
import { redis } from '../lib/redis.ts';
import { pushToUsers } from './push.ts';

const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;

const MESSAGES: Record<string, { subject: string; body: string }> = {
  NEEDS_ATTENTION: {
    subject: 'needs you to log in again',
    body: 'LinkedIn logged this account out or asked for a security check. Sending is paused until someone with full access logs in again through Live View.',
  },
  SEND_PAUSED: {
    subject: 'sending paused after a LinkedIn warning',
    body: 'LinkedIn showed a limit or restriction warning while sending, so sending from this account was paused automatically and its daily limit starts low again. Check the account in Live View, then resume sending under Accounts when it looks normal.',
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
    WHERE u.disabled_at IS NULL AND (u.role IN ('OWNER', 'ADMIN') OR u.id = ${account.ownerUserId} OR g.level = 'FULL')`;
  if (!recipients.length) return;

  const link = config.appUrl ? `${config.appUrl}/accounts${status === 'SEND_PAUSED' ? '' : `/${accountId}/connect`}` : '';
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

/** A notice for the owner and admins: a notification in their browsers and, with SMTP set up, an email. */
export async function alertAdmins(subject: string, body: string, path: string) {
  const admins = await sql`SELECT id, email FROM users WHERE disabled_at IS NULL AND role IN ('OWNER', 'ADMIN')`;
  if (!admins.length) return;
  await pushToUsers(
    admins.map((a) => a.id as string),
    { title: subject, body: body.slice(0, 160), url: path, tag: `admin-${subject}` },
  ).catch((err) => logger.warn({ err }, 'admin push failed'));
  if (!transport) return;
  const link = config.appUrl ? `\n\n${config.appUrl}${path}\n` : '';
  try {
    await transport.sendMail({
      from: config.alertFrom,
      to: admins.map((a) => a.email).join(', '),
      subject: `LinkedIn Console: ${subject}`,
      text: `${body}${link}`,
    });
  } catch (e) {
    logger.error({ err: e }, 'admin alert email failed');
  }
}
