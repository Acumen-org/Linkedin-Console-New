// Recognise the connection-request calls Live LinkedIn makes when a teammate clicks Connect / withdraws a request
// (C1). Pure, so it can be unit-tested without a browser; the reader feeds it the request's method/url/body.
//
// NOTE: the exact invite endpoint + body shape drift and are NOT verified against a real logged-in account — confirm
// them in a capture pass (docs/bridge-maintenance.md) and adjust INVITE_URL / findMemberUrn here only.
export interface ParsedInvite {
  action: 'sent' | 'withdrawn';
  memberUrn: string;
  note: string | null;
}

/** LinkedIn's invite endpoints, old and new (best-effort; confirm in the capture pass). */
const INVITE_URL = /normInvitations|voyagerRelationshipsDashMemberRelationships|relationships\/[a-zA-Z]*[Ii]nvitation/;
const MEMBER_URN = /urn:li:fsd_profile:[A-Za-z0-9_-]+/;

/** The invitee member URN from a request body, across the shapes LinkedIn has used. */
function findMemberUrn(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const j = body as Record<string, unknown>;
  // normInvitations: invitee['com.linkedin.voyager.growth.invitation.InviteeProfile'].profileId = <memberId | urn>
  const invitee = j.invitee as Record<string, unknown> | undefined;
  const profile = invitee?.['com.linkedin.voyager.growth.invitation.InviteeProfile'] as Record<string, unknown> | undefined;
  const pid = profile?.profileId;
  if (typeof pid === 'string') return pid.startsWith('urn:') ? pid : `urn:li:fsd_profile:${pid}`;
  // dash MemberRelationships and similar: an explicit invitee profile URN field.
  for (const k of ['inviteeProfileUrn', 'inviteeUrn', 'invitee', 'inviteeMemberUrn']) {
    const v = j[k];
    if (typeof v === 'string' && v.includes('fsd_profile')) return v;
  }
  return null;
}

/** Parse one observed request into an invite action, or null when it isn't an invite call. */
export function parseInvite(method: string, url: string, body: string | null): ParsedInvite | null {
  if (!INVITE_URL.test(url)) return null;
  const action: ParsedInvite['action'] = method.toUpperCase() === 'DELETE' || /withdraw|delete/i.test(url) ? 'withdrawn' : 'sent';
  let parsed: unknown;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {}
  }
  const p = parsed as Record<string, unknown> | undefined;
  const note = (typeof p?.message === 'string' && p.message) || (typeof p?.customMessage === 'string' && p.customMessage) || null;
  // From the body's known shapes, else any member URN in the body or URL (withdraw often carries it in the path).
  const memberUrn = findMemberUrn(parsed) ?? body?.match(MEMBER_URN)?.[0] ?? url.match(MEMBER_URN)?.[0] ?? null;
  if (!memberUrn) return null;
  return { action, memberUrn, note: note ? note.slice(0, 300) : null };
}
