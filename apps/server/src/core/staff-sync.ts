// Follows the Twilio console's staff list (GET /api/staff, server API key):
//  - links teammates to their staff record (by email or email alias),
//  - disables and signs out anyone resigned or archived there, and re-enables them if that's undone,
//  - with STAFF_SYNC=provision, adds active staff as members (no account access until granted,
//    Microsoft sign-in only).
// Never touches the owner and never changes roles. Refuses to act on an empty or failed list, or when a
// run would disable an unusual share of the team at once.
import { z } from 'zod';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { newId } from '../lib/ids.ts';
import { logger } from '../lib/logger.ts';
import { publish, redis } from '../lib/redis.ts';
import { audit } from './audit.ts';

const Staff = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string().nullish(),
  email: z.string().nullish(),
  email_aliases: z.array(z.string()).nullish(),
  resigned_at: z.string().nullish(),
  archived_at: z.string().nullish(),
  auto_imported: z.boolean().nullish(),
});
type Staff = z.infer<typeof Staff>;

export interface StaffSyncStatus {
  at: string;
  ok: boolean;
  error?: string;
  staff?: number;
  linked?: number;
  disabled?: number;
  reenabled?: number;
  provisioned?: number;
}

const STATUS_KEY = 'lu:staffsync:status';
const norm = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();

async function twilio(path: string) {
  const res = await fetch(`${config.staffSync.url}${path}`, {
    headers: { authorization: `Bearer ${config.staffSync.apiKey}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  return res;
}

async function fetchStaff(): Promise<Staff[]> {
  const res = await twilio('/api/staff?includeResigned=true');
  if (!res.ok) throw new Error(`Twilio console answered ${res.status}`);
  const list = z.array(Staff).parse(await res.json());
  if (!list.length) throw new Error('Twilio console returned an empty staff list');
  return list;
}

/** A linked record missing from the list: archived, merged into another record, or deleted. */
async function lookupMissing(staffId: string): Promise<{ staff: Staff | null; archived: boolean }> {
  const res = await twilio(`/api/staff/${encodeURIComponent(staffId)}`);
  if (res.status === 404) return { staff: null, archived: true };
  if (!res.ok) throw new Error(`Twilio console answered ${res.status} for staff ${staffId}`);
  const staff = Staff.parse(await res.json());
  return { staff, archived: !!staff.archived_at };
}

async function grantDefault(userId: string) {
  if (config.defaultGrant === 'NONE') return;
  await sql`INSERT INTO account_grants (account_id, user_id, level) SELECT id, ${userId}, ${config.defaultGrant} FROM accounts ON CONFLICT DO NOTHING`;
}

export async function runStaffSync(): Promise<StaffSyncStatus> {
  const status: StaffSyncStatus = { at: new Date().toISOString(), ok: false };
  try {
    const staff = await fetchStaff();
    const byId = new Map(staff.map((s) => [s.id, s]));
    const byEmail = new Map<string, Staff>();
    for (const s of staff) for (const e of [s.email, ...(s.email_aliases ?? [])]) if (norm(e)) byEmail.set(norm(e), s);

    const users = await sql`SELECT id, email, name, role, staff_id, disabled_at, disabled_by FROM users`;
    const takenStaffIds = new Set(users.map((u) => u.staffId).filter(Boolean));
    const plan: { user: (typeof users)[number]; staff: Staff | null; leaver: string | null; link: string | null }[] = [];

    for (const u of users) {
      if (u.role === 'OWNER') continue;
      let s = (u.staffId && byId.get(u.staffId)) || byEmail.get(norm(u.email)) || null;
      let leaver: string | null = null;
      if (!s && u.staffId) {
        const found = await lookupMissing(u.staffId);
        s = found.staff;
        if (found.archived) leaver = 'Archived in the Twilio console';
      }
      if (!s && !leaver) continue; // not on the staff list: managed here only
      if (s?.resigned_at) leaver = 'Resigned in the Twilio console';
      const link = s && s.id !== u.staffId && !takenStaffIds.has(s.id) ? s.id : null;
      if (link) takenStaffIds.add(link);
      plan.push({ user: u, staff: s, leaver, link });
    }

    const toDisable = plan.filter((p) => p.leaver && !p.user.disabledAt);
    const limit = Math.max(3, Math.ceil(plan.length * 0.25));
    if (toDisable.length > limit) {
      throw new Error(
        `would disable ${toDisable.length} of ${plan.length} linked teammates at once; nothing changed (check the Twilio staff list)`,
      );
    }

    for (const p of plan.filter((x) => x.link)) {
      await sql`UPDATE users SET staff_id = ${p.link} WHERE id = ${p.user.id}`;
    }
    for (const p of toDisable) {
      await sql`
        UPDATE users SET disabled_at = now(), disabled_reason = ${p.leaver}, disabled_by = 'staff_sync' WHERE id = ${p.user.id}`;
      await sql`DELETE FROM sessions WHERE user_id = ${p.user.id}`;
      await publish(`user:${p.user.id}`, 'grants.changed', {});
      await audit({
        action: 'user.deprovisioned',
        meta: { targetUserId: p.user.id, email: p.user.email, reason: p.leaver, staffId: p.staff?.id },
      });
    }
    const toEnable = plan.filter((p) => !p.leaver && p.user.disabledAt && p.user.disabledBy === 'staff_sync');
    for (const p of toEnable) {
      await sql`UPDATE users SET disabled_at = NULL, disabled_reason = NULL, disabled_by = NULL WHERE id = ${p.user.id}`;
      await audit({ action: 'user.reenabled', meta: { targetUserId: p.user.id, email: p.user.email, staffId: p.staff?.id } });
    }

    let provisioned = 0;
    if (config.staffSync.mode === 'provision') {
      const known = new Set(users.map((u) => norm(u.email)));
      for (const s of staff) {
        const email = norm(s.email);
        if (!email || s.resigned_at || s.archived_at || s.auto_imported || takenStaffIds.has(s.id)) continue;
        if ([email, ...(s.email_aliases ?? []).map(norm)].some((e) => known.has(e))) continue;
        const id = newId('usr');
        await sql`
          INSERT INTO users (id, email, name, password_hash, role, source, staff_id)
          VALUES (${id}, ${email}, ${s.name?.trim() || email}, NULL, 'MEMBER', 'staff_sync', ${s.id})
          ON CONFLICT DO NOTHING`;
        await grantDefault(id);
        known.add(email);
        takenStaffIds.add(s.id);
        provisioned++;
        await audit({ action: 'user.provisioned', meta: { targetUserId: id, email, staffId: s.id } });
      }
    }

    Object.assign(status, {
      ok: true,
      staff: staff.length,
      linked: plan.filter((p) => p.staff).length,
      disabled: toDisable.length,
      reenabled: toEnable.length,
      provisioned,
    });
  } catch (err) {
    status.error = (err as Error).message;
    logger.error({ err }, 'staff sync failed');
  }
  await redis.set(STATUS_KEY, JSON.stringify(status));
  return status;
}

export async function lastStaffSync(): Promise<StaffSyncStatus | null> {
  const raw = await redis.get(STATUS_KEY);
  return raw ? JSON.parse(raw) : null;
}
