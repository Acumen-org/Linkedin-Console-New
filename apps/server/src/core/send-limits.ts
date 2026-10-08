// How much a LinkedIn account may send, so it keeps looking like one person: a daily cap for everything sent
// from the app, a lower one for new chats (cold outreach), and a ramp-up for newly connected accounts.

import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { conflict, HttpError } from '../lib/errors.ts';

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
