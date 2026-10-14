// Follows a staff list: the Twilio console's (GET /api/staff, server API key) or the members of the Twenty CRM
// workspace (STAFF_SOURCE=twenty):
//  - links teammates to their staff record (by email or email alias),
//  - disables and signs out anyone resigned, archived or removed there, and re-enables them if that's undone,
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
import { workspaceMembers } from '../lib/twenty.ts';
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

/** A staff list. Its ids are recognisable, so links made from another source are never mistaken for leavers. */
interface Source {
  label: string;
  owns: (staffId: string) => boolean;
  list: () => Promise<Staff[]>;
  lookupMissing: (staffId: string) => Promise<{ staff: Staff | null; archived: boolean }>;
  reasons: { resigned: string; archived: string };
}

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

const TWENTY = 'twenty:';

const sources: Record<'twilio' | 'twenty', Source> = {
  twilio: {
    label: 'Twilio staff list',
    owns: (id) => !id.startsWith(TWENTY),
    list: fetchStaff,
    lookupMissing,
    reasons: { resigned: 'Resigned in the Twilio console', archived: 'Archived in the Twilio console' },
  },
  twenty: {
    label: 'Twenty workspace',
    owns: (id) => id.startsWith(TWENTY),
    async list() {
      const members = await workspaceMembers();
      if (!members.length) throw new Error('Twenty CRM returned no workspace members');
      if (!members.some((m) => m.email)) throw new Error("This Twenty CRM version doesn't share members' emails; nothing changed");
      return members.map((m) => ({ id: TWENTY + m.id, name: m.name, email: m.email }));
    },
    // The list is complete (every page): someone linked but not in it was removed from the workspace.
    lookupMissing: async () => ({ staff: null, archived: true }),
    reasons: { resigned: 'Removed from the Twenty workspace', archived: 'Removed from the Twenty workspace' },
  },
};
type SourceKind = keyof typeof sources;

async function grantDefault(userId: string) {
  if (config.defaultGrant === 'NONE') return;
  await sql`INSERT INTO account_grants (account_id, user_id, level) SELECT id, ${userId}, ${config.defaultGrant} FROM accounts ON CONFLICT DO NOTHING`;
}

const LOCK_KEY = 'lu:staffsync:lock';

/** One run at a time across api ("Sync now") and worker (schedule). `source` overrides STAFF_SOURCE (tests). */
export async function runStaffSync(opts: { source?: SourceKind } = {}): Promise<StaffSyncStatus> {
  if (!(await redis.set(LOCK_KEY, '1', 'EX', 300, 'NX'))) {
    return { at: new Date().toISOString(), ok: false, error: 'A sync is already running; try again in a moment' };
  }
  try {
    return await syncOnce(sources[opts.source ?? config.staffSync.source]);
  } finally {
    await redis.del(LOCK_KEY);
  }
}

async function syncOnce(src: Source): Promise<StaffSyncStatus> {
  const status: StaffSyncStatus = { at: new Date().toISOString(), ok: false };
  try {
    const staff = await src.list();
    const byId = new Map(staff.map((s) => [s.id, s]));
    const byEmail = new Map<string, Staff>();
    for (const s of staff) for (const e of [s.email, ...(s.email_aliases ?? [])]) if (norm(e)) byEmail.set(norm(e), s);

    const users = await sql`SELECT id, email, name, role, staff_id, disabled_at, disabled_by FROM users`;
    // Links made from the other source (after switching STAFF_SOURCE) are ignored, not treated as leavers.
    const own = (id: string | null) => (id && src.owns(id) ? id : null);
    const takenStaffIds = new Set(users.map((u) => own(u.staffId)).filter(Boolean));
    const plan: { user: (typeof users)[number]; staff: Staff | null; leaver: string | null; link: string | null }[] = [];

    for (const u of users) {
      if (u.role === 'OWNER') continue;
      const linkedId = own(u.staffId);
      let s = (linkedId && byId.get(linkedId)) || byEmail.get(norm(u.email)) || null;
      let leaver: string | null = null;
      if (!s && linkedId) {
        const found = await src.lookupMissing(linkedId);
        s = found.staff;
        if (found.archived) leaver = src.reasons.archived;
      }
      if (!s && !leaver) continue; // not on the staff list: managed here only
      if (s?.resigned_at) leaver = src.reasons.resigned;
      const link = s && s.id !== linkedId && !takenStaffIds.has(s.id) ? s.id : null;
      if (link) takenStaffIds.add(link);
      plan.push({ user: u, staff: s, leaver, link });
    }

    const toDisable = plan.filter((p) => p.leaver && !p.user.disabledAt);
    const limit = Math.max(3, Math.ceil(plan.length * 0.25));
    if (toDisable.length > limit) {
      throw new Error(
        `would disable ${toDisable.length} of ${plan.length} linked teammates at once; nothing changed (check the ${src.label})`,
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
        const created = await sql`
          INSERT INTO users (id, email, name, password_hash, role, source, staff_id)
          VALUES (${id}, ${email}, ${s.name?.trim() || email}, NULL, 'MEMBER', 'staff_sync', ${s.id})
          ON CONFLICT DO NOTHING
          RETURNING id`;
        if (!created.length) continue; // added meanwhile (e.g. by hand)
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
