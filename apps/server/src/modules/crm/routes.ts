// Binding prospects to Twenty CRM by hand (Needs CRM binding): the conversation's binding state, Persons to
// choose from, bind to existing / add as new (anyone who can reply on the account), unbind (admins).
// Also the list of Twenty users, for linking teammates to them on the Team page.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessibleAccountIds, conversationForUser } from '../../core/access.ts';
import { requireAdmin, requireUser } from '../../core/auth.ts';
import { config } from '../../lib/config.ts';
import { sql } from '../../lib/db.ts';
import { HttpError } from '../../lib/errors.ts';
import { peopleByIds, searchPeople, twentyWebUrl, workspaceMembers } from '../../lib/twenty.ts';
import { addAsNew, bindToExisting, crmFields, prospectOf, unbindAndDeleteByAdmin, unbindByAdmin } from '../../worker/crm-binding.ts';

const personUrl = (personId: string | null) => (personId && twentyWebUrl() ? `${twentyWebUrl()}/object/person/${personId}` : null);

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
    const personId = conversation.twentyPersonId as string | null;
    // The bound Person's name, for the inline badge; best-effort (a Twenty outage just leaves it null).
    const personName = personId ? ((await peopleByIds([personId]).catch(() => null))?.get(personId) ?? null) : null;
    return {
      binding: conversation.crmBinding as 'needed' | 'bound' | null,
      reason: conversation.crmBindingReason as string | null,
      personId,
      personUrl: personUrl(personId),
      personName,
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

  // Deliberate, admin-only "unbind AND delete from Twenty": removes the bound Person and its LinkedIn-conversation
  // records from Twenty, then unbinds locally. Destructive and irreversible — never automatic, always confirm-first
  // in the UI. If the Twenty delete fails (already gone / busy), the prospect is still unbound and the body says so.
  app.post<{ Params: Params }>('/api/conversations/:id/crm/unbind-delete', async (req) => {
    requireCrm();
    const admin = requireAdmin(req);
    await conversationForUser(admin, req.params.id, 'READ');
    return unbindAndDeleteByAdmin(req.params.id, admin, req.ip);
  });

  // Every bound prospect and the Twenty Person they map to, plus a scoped summary (bound / needs binding / unbound):
  // which LinkedIn prospect is bound to which Person, who bound them and how. Admins see all accounts; everyone else
  // only the accounts they are granted (same as the inbox). A binding spans every 1:1 conversation with the prospect
  // in those accounts: the representative conversation (its newest) backs the admin Unbind and the Twenty link.
  app.get('/api/crm/bindings', async (req) => {
    requireCrm();
    const user = requireUser(req);
    const ids = await accessibleAccountIds(user);
    if (!ids.length) return { bindings: [], summary: { bound: 0, needsBinding: 0, unbound: 0 } };

    // One prospect (member URN) can have several 1:1 conversations across accounts: fold them together.
    const rows = await sql<
      {
        memberUrn: string;
        personId: string;
        method: string;
        boundAt: Date;
        boundByName: string | null;
        prospect: string;
        accountLabels: string[];
        replied: boolean;
        conversationId: string;
      }[]
    >`
      WITH prospect AS (
        SELECT c.participants->0->>'urn' AS member_urn,
               coalesce(max(c.title), max(c.participants->0->>'name'), 'LinkedIn Member') AS prospect,
               array_agg(DISTINCT a.label ORDER BY a.label) AS account_labels,
               bool_or(EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'INBOUND')) AS replied,
               (array_agg(c.id ORDER BY c.last_message_at DESC NULLS LAST))[1] AS conversation_id
        FROM conversations c JOIN accounts a ON a.id = c.account_id
        WHERE NOT c.is_group AND c.account_id IN ${sql(ids)} AND c.participants->0->>'urn' LIKE 'urn:li:%'
        GROUP BY c.participants->0->>'urn'
      )
      SELECT b.member_urn, b.person_id, b.method, b.bound_at, u.name AS bound_by_name,
             p.prospect, p.account_labels, p.replied, p.conversation_id
      FROM crm_bindings b
      JOIN prospect p ON p.member_urn = b.member_urn
      LEFT JOIN users u ON u.id = b.bound_by
      ORDER BY b.bound_at DESC
      LIMIT 2000`;

    // Names from Twenty, best-effort: a Person deleted or merged there (or a Twenty outage) just shows no name.
    const names = rows.length ? await peopleByIds(rows.map((r) => r.personId)).catch(() => new Map<string, string>()) : new Map();
    const bindings = rows.map((r) => ({
      memberUrn: r.memberUrn,
      prospect: r.prospect,
      accountLabels: r.accountLabels,
      replied: r.replied,
      conversationId: r.conversationId,
      personId: r.personId,
      personName: names.get(r.personId) ?? null,
      personUrl: personUrl(r.personId),
      method: r.method,
      boundByName: r.boundByName,
      boundAt: r.boundAt,
    }));

    // Scoped to the same accounts: bound prospects, replies still waiting to be bound, and replied-but-undecided.
    const [summary] = await sql<{ bound: number; needsBinding: number; unbound: number }[]>`
      SELECT count(DISTINCT participants->0->>'urn') FILTER (WHERE crm_binding = 'bound')::int AS bound,
             count(*) FILTER (WHERE crm_binding = 'needed')::int AS needs_binding,
             count(DISTINCT participants->0->>'urn') FILTER (
               WHERE crm_binding IS NULL AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'INBOUND')
             )::int AS unbound
      FROM conversations c WHERE NOT is_group AND account_id IN ${sql(ids)}`;

    // Prospects an admin explicitly unbound (crm_binding_at = 'infinity' marks "never auto-rebind"): shown so they can
    // be reviewed and bound again by hand. One row per prospect; the reason records who unbound them and why.
    const unboundRows = await sql<
      { memberUrn: string; prospect: string; accountLabel: string; conversationId: string; reason: string | null }[]
    >`
      SELECT DISTINCT ON (c.participants->0->>'urn')
             c.participants->0->>'urn' AS member_urn,
             coalesce(c.title, c.participants->0->>'name', 'LinkedIn Member') AS prospect,
             a.label AS account_label,
             c.id AS conversation_id,
             c.crm_binding_reason AS reason
      FROM conversations c JOIN accounts a ON a.id = c.account_id
      WHERE NOT c.is_group AND c.account_id IN ${sql(ids)}
        AND c.crm_binding = 'needed' AND c.crm_binding_at = 'infinity'
      ORDER BY c.participants->0->>'urn', c.last_message_at DESC NULLS LAST
      LIMIT 500`;
    const unbound = unboundRows.map((r) => ({
      memberUrn: r.memberUrn,
      prospect: r.prospect,
      accountLabels: [r.accountLabel],
      conversationId: r.conversationId,
      reason: r.reason,
    }));
    return { bindings, summary, unbound };
  });

  // Twenty users, to link teammates to (owner of the Persons they add).
  app.get('/api/crm/members', async (req) => {
    requireCrm();
    requireAdmin(req);
    return workspaceMembers();
  });
}
