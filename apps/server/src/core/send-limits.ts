// How much a LinkedIn account may send, so it keeps looking like one person: a daily cap for everything sent
// from the app, a lower one for new chats (cold outreach), and a ramp-up for newly connected accounts.

import { config } from '../lib/config.ts';
import { getSetting, setSetting, sql } from '../lib/db.ts';
import { conflict, HttpError } from '../lib/errors.ts';
import { redis } from '../lib/redis.ts';
import { alertAdmins } from '../worker/alerts.ts';
import { audit } from './audit.ts';

/** The cap in effect today: newly connected accounts start low and grow a step per day up to their cap. */
export const effectiveCapSql = sql`
  CASE WHEN a.ramp_started_at IS NULL THEN a.daily_send_cap
       ELSE least(a.daily_send_cap,
                  ${config.sendRamp.start}::int + ${config.sendRamp.step}::int * floor(extract(epoch FROM now() - a.ramp_started_at) / 86400)::int)
  END`;

/** Days until the ramp reaches the account's cap (null = no ramp running). */
export const rampDaysLeftSql = sql`
  CASE WHEN a.ramp_started_at IS NULL THEN NULL
       ELSE greatest(0, ceil((a.daily_send_cap - ${config.sendRamp.start}::int)::numeric / ${config.sendRamp.step}::int)::int
                        - floor(extract(epoch FROM now() - a.ramp_started_at) / 86400)::int)
  END`;

/** Throws when this account may not send now (status, pause, today's caps). `kind` = reply or new chat. */
export async function assertCanSend(accountId: string, kind: 'reply' | 'new_chat' = 'reply') {
  const [a] = await sql`
    SELECT a.status, a.send_paused, a.paused_reason, a.new_chat_cap, ${effectiveCapSql} AS cap, a.daily_send_cap
    FROM accounts a WHERE a.id = ${accountId}`;
  if (a.status !== 'CONNECTED') throw conflict('This LinkedIn account is not connected right now');
  if (a.sendPaused) throw conflict(a.pausedReason ? `Sending is paused: ${a.pausedReason}` : 'Sending is paused for this account');
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM messages
    WHERE account_id = ${accountId} AND sent_by_user_id IS NOT NULL AND created_at > now() - interval '24 hours' AND status <> 'FAILED'`;
  if (n >= a.cap) {
    const ramp = a.cap < a.dailySendCap ? ' while this newly connected account ramps up' : '';
    throw new HttpError(429, `Daily send limit reached for this account (${a.cap}/24h${ramp})`);
  }
  if (kind === 'new_chat') {
    const [{ chats }] = await sql`
      SELECT count(*)::int AS chats FROM audit_log
      WHERE account_id = ${accountId} AND action = 'message.start_chat' AND created_at > now() - interval '24 hours'`;
    if (chats >= a.newChatCap) throw new HttpError(429, `Daily limit for new chats reached for this account (${a.newChatCap}/24h)`);
  }
}

// ---------- Per teammate ----------
// Staff also have their own limit per 24 hours (messages and new chats, over all accounts): the team default
// (Team page), or their own. Admins and the owner have none. Admins are alerted, once a day per person, when
// someone gets close to their limit or sends unusually much within an hour.

export interface StaffLimits {
  /** Team default per staff member per 24 hours; 0 = no limit. */
  dailyCap: number;
  /** Alert admins when one person sends more than this within an hour; 0 = never. */
  burstPerHour: number;
}

export async function staffLimits(): Promise<StaffLimits> {
  return { dailyCap: 0, burstPerHour: 30, ...((await getSetting<Partial<StaffLimits>>('staff_limits')) ?? {}) };
}

export async function setStaffLimits(limits: StaffLimits) {
  await setSetting('staff_limits', limits);
}

/** Messages and new chats this person sent from the app in the last `hours`. */
export async function sendsBy(userId: string, hours = 24) {
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM audit_log
    WHERE user_id = ${userId} AND action IN ('message.send', 'message.start_chat')
      AND created_at > now() - make_interval(hours => ${hours})`;
  return n as number;
}

async function capOf(user: { id: string; role: string }) {
  if (user.role !== 'MEMBER') return 0;
  const [u] = await sql`SELECT daily_send_cap FROM users WHERE id = ${user.id}`;
  return (u?.dailySendCap as number | null) ?? (await staffLimits()).dailyCap;
}

/** Throws when this teammate reached their own limit. */
export async function assertStaffCanSend(user: { id: string; role: string }) {
  const cap = await capOf(user);
  if (!cap) return;
  if ((await sendsBy(user.id)) >= cap) {
    throw new HttpError(429, `You reached your limit of ${cap} messages in 24 hours. An admin can change it on the Team page.`);
  }
}

/** After a send: tell the admins (once a day per person and reason) when it looks unusual. */
export async function watchStaffVolume(user: { id: string; role: string; name: string }) {
  if (user.role !== 'MEMBER') return;
  const [cap, limits, day, hour] = await Promise.all([capOf(user), staffLimits(), sendsBy(user.id), sendsBy(user.id, 1)]);
  const reasons: [string, string][] = [];
  if (cap && day >= Math.ceil(cap * 0.8)) reasons.push(['near_limit', `${user.name} sent ${day} of their ${cap} messages for 24 hours`]);
  if (limits.burstPerHour && hour > limits.burstPerHour)
    reasons.push(['burst', `${user.name} sent ${hour} messages in the last hour (alert above ${limits.burstPerHour})`]);
  for (const [reason, text] of reasons) {
    if (!(await redis.set(`lu:volume:${user.id}:${reason}`, '1', 'EX', 24 * 3600, 'NX'))) continue;
    await audit({ userId: user.id, action: 'user.volume_alert', meta: { reason, last24h: day, lastHour: hour, cap } });
    await alertAdmins(`Unusual sending: ${user.name}`, `${text}. See Activity in LinkedIn Console for what they sent.`, '/activity');
  }
}
