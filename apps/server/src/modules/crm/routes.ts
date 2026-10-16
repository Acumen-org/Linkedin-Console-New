// Binding prospects to Twenty CRM by hand (Needs CRM binding): the conversation's binding state, Persons to
// choose from, bind to existing / add as new (anyone who can reply on the account), unbind (admins).
// Also the list of Twenty users, for linking teammates to them on the Team page.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { conversationForUser } from '../../core/access.ts';
import { requireAdmin, requireUser } from '../../core/auth.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { searchPeople, twentyWebUrl, workspaceMembers } from '../../lib/twenty.ts';
import { addAsNew, bindToExisting, crmFields, prospectOf, unbindByAdmin } from '../../worker/crm-binding.ts';

type Params = { id: string };

const requireCrm = () => {
  if (!config.crmSync || !config.twenty) throw new HttpError(409, 'The Twenty CRM sync is off (CRM_SYNC)');
};

export default async function crmRoutes(app: FastifyInstance) {
  app.get<{ Params: Params }>('/api/conversations/:id/crm', async (req) => {
    requireCrm();
    const user = requireUser(req);
    const { conversation } = await conversationForUser(user, req.params.id, 'READ');
    const prospect = await prospectOf(conversation.accountId, conversation.participants ?? []);
    const [me] = await sql`SELECT twenty_member_id, pod FROM users WHERE id = ${user.id}`;
    const fields = await crmFields().catch(() => ({ owner: null, pod: null, source: false, memberId: false }));
    return {
      binding: conversation.crmBinding as 'needed' | 'bound' | null,
      reason: conversation.crmBindingReason as string | null,
      personId: conversation.twentyPersonId as string | null,
      personUrl: conversation.twentyPersonId ? `${twentyWebUrl()}/object/person/${conversation.twentyPersonId}` : null,
      prospect: { name: prospect.name, headline: prospect.headline, profileUrl: prospect.profileUrl, identified: !!prospect.memberUrn },
      // What "Add as new" will set, and what is missing for it.
      owner: { field: fields.owner, memberId: (me?.twentyMemberId as string | null) ?? null },
      pod: { field: fields.pod, value: (me?.pod as string | null) ?? null },
    };
  });

  app.get<{ Params: Params }>('/api/conversations/:id/crm/candidates', async (req) => {
    requireCrm();
    const user = requireUser(req);
    const { conversation } = await conversationForUser(user, req.params.id, 'REPLY');
    const { q } = z.object({ q: z.string().max(200).optional() }).parse(req.query);
    const prospect = await prospectOf(conversation.accountId, conversation.participants ?? []);
    const fields = await crmFields();
    return searchPeople(q ?? prospect.name, prospect.profileUrl, fields.owner);
  });

  app.post<{ Params: Params }>('/api/conversations/:id/crm/bind', async (req) => {
    requireCrm();
    const user = requireUser(req);
    await conversationForUser(user, req.params.id, 'REPLY');
    const { personId } = z.object({ personId: z.string().uuid() }).parse(req.body);
    return bindToExisting(req.params.id, personId, user, req.ip);
  });

  app.post<{ Params: Params }>('/api/conversations/:id/crm/add', async (req) => {
    requireCrm();
    const user = requireUser(req);
    await conversationForUser(user, req.params.id, 'REPLY');
    return addAsNew(req.params.id, user, req.ip);
  });

  app.post<{ Params: Params }>('/api/conversations/:id/crm/unbind', async (req) => {
    requireCrm();
    const admin = requireAdmin(req);
    await conversationForUser(admin, req.params.id, 'READ');
    await unbindByAdmin(req.params.id, admin, req.ip);
    return { ok: true };
  });

  // Twenty users, to link teammates to (owner of the Persons they add).
  app.get('/api/crm/members', async (req) => {
    requireCrm();
    requireAdmin(req);
    return workspaceMembers();
  });
}
