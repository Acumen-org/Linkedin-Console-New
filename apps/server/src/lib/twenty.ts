// Twenty CRM over GraphQL (TWENTY_API_URL = https://…/graphql, TWENTY_API_KEY = an API key from Twenty).
// The same values the Twilio console uses.
import { config } from './config.ts';
import { CONVERSATION_OBJECT } from './twenty-fields.ts';

export class TwentyError extends Error {}

/** One GraphQL request; GraphQL errors and HTTP errors both throw (callers decide whether to retry). */
export async function twentyQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  if (!config.twenty) throw new TwentyError('Twenty CRM is not configured (TWENTY_API_URL, TWENTY_API_KEY)');
  const res = await fetch(config.twenty.url, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.twenty.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new TwentyError(`Twenty CRM answered ${res.status}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new TwentyError(`Twenty CRM: ${body.errors.map((e) => e.message).join('; ')}`);
  if (!body.data) throw new TwentyError('Twenty CRM returned no data');
  return body.data;
}

export interface WorkspaceMember {
  id: string;
  name: string | null;
  email: string | null;
}

const MEMBERS = `
  query LinkedInConsoleWorkspaceMembers($after: String) {
    workspaceMembers(first: 200, after: $after) {
      edges { node { id name { firstName lastName } userEmail } }
      pageInfo { hasNextPage endCursor }
    }
  }`;

type MembersPage = {
  workspaceMembers: {
    edges: { node: { id: string; name?: { firstName?: string | null; lastName?: string | null } | null; userEmail?: string | null } }[];
    pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  };
};

/** Everyone in the Twenty workspace (all pages: a missing page would look like people leaving). */
export async function workspaceMembers(): Promise<WorkspaceMember[]> {
  const out: WorkspaceMember[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const data: MembersPage = await twentyQuery<MembersPage>(MEMBERS, { after });
    for (const { node } of data.workspaceMembers.edges) {
      const name = `${node.name?.firstName ?? ''} ${node.name?.lastName ?? ''}`.trim();
      out.push({ id: node.id, name: name || null, email: node.userEmail?.trim().toLowerCase() || null });
    }
    const info = data.workspaceMembers.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) return out;
    after = info.endCursor;
  }
  throw new TwentyError('Twenty CRM returned more pages of workspace members than expected');
}

// ---------- People and notes (prospects and their LinkedIn messages) ----------

/** Twenty's web app (TWENTY_WEB_URL, else the API address without /graphql). */
export const twentyWebUrl = () => config.twenty?.webUrl ?? null;

type PeopleResult = { people: { edges: { node: { id: string; linkedinLink?: { primaryLinkUrl?: string | null } | null } }[] } };

const FIND_PEOPLE = `
  query LinkedInConsoleFindPeople($filter: PersonFilterInput) {
    people(filter: $filter, first: 10) { edges { node { id linkedinLink { primaryLinkUrl } } } }
  }`;

/** The profile's stable part ("linkedin.com/in/jane-doe"), for matching however the link was typed in Twenty. */
export function linkedinKey(url: string | null | undefined) {
  const m = String(url ?? '').match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return null;
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {} // a malformed %-sequence: compare it as typed
  return `linkedin.com/in/${slug.toLowerCase()}`;
}

/**
 * Every Twenty Person whose LinkedIn link is this profile (however it was typed: with or without https, www,
 * a trailing slash or tracking parameters). Exactly one = safe to bind; none or several = a person decides.
 * Never matches by name.
 */
export async function peopleWithLinkedin(profileUrl: string): Promise<string[]> {
  const key = linkedinKey(profileUrl);
  if (!key) return [];
  // `like` (case-sensitive), not `ilike`: some Twenty versions silently ignore `ilike` on a LINKS composite
  // sub-field and return everything, which then matches nothing. Vanity ids are lowercase, and `key` is lowercased,
  // so a case-sensitive substring match is correct here; the exact-key filter below is the final guard.
  const found = await twentyQuery<PeopleResult>(FIND_PEOPLE, {
    filter: { linkedinLink: { primaryLinkUrl: { like: `%${key.replace(/[%_]/g, '')}%` } } },
  });
  return found.people.edges.filter((e) => linkedinKey(e.node.linkedinLink?.primaryLinkUrl) === key).map((e) => e.node.id);
}

/** A new Person for a prospect (only on a teammate's "Add as new"). */
export async function createPerson(p: {
  name: string;
  profileUrl: string | null;
  headline: string | null;
  extra?: Record<string, unknown>;
}) {
  const [firstName, ...rest] = p.name.trim().split(/\s+/);
  const created = await twentyQuery<{ createPerson: { id: string } }>(
    `mutation LinkedInConsoleCreatePerson($input: PersonCreateInput!) { createPerson(data: $input) { id } }`,
    {
      input: {
        name: { firstName: firstName || 'LinkedIn', lastName: firstName ? rest.join(' ') : 'Member' },
        ...(p.profileUrl ? { linkedinLink: { primaryLinkUrl: p.profileUrl, primaryLinkLabel: 'LinkedIn' } } : {}),
        ...(p.headline ? { jobTitle: p.headline.slice(0, 250) } : {}),
        ...p.extra,
      },
    },
  );
  return created.createPerson.id;
}

/** Changes fields of a Person; false when the Person no longer exists. */
export async function updatePerson(personId: string, data: Record<string, unknown>) {
  try {
    await twentyQuery(
      `mutation LinkedInConsoleUpdatePerson($id: UUID!, $input: PersonUpdateInput!) { updatePerson(id: $id, data: $input) { id } }`,
      {
        id: personId,
        input: data,
      },
    );
    return true;
  } catch (err) {
    if (/not found|does not exist|no record/i.test((err as Error).message)) return false;
    throw err;
  }
}

/**
 * Deletes a Person in Twenty. True when it deleted, false when the Person is already gone (deleted or merged there);
 * any other error throws. Only ever reached by the deliberate admin "unbind and delete", never by the sync.
 */
export async function deletePersonInTwenty(personId: string): Promise<boolean> {
  try {
    await twentyQuery(`mutation LinkedInConsoleDeletePerson($id: UUID!) { deletePerson(id: $id) { id } }`, { id: personId });
    return true;
  } catch (err) {
    if (/not found|does not exist|no record/i.test((err as Error).message)) return false;
    throw err;
  }
}

/**
 * Deletes every LinkedIn-conversation record linked to a Person (found by the relation's personId, deleted one by
 * one, paging through them). Tolerant: a workspace without the custom object, or a record already gone, is not an
 * error — it just deletes what it finds. Returns how many it deleted. Paired with deletePersonInTwenty on the
 * admin "unbind and delete" so a prospect's records don't linger after their Person is removed.
 */
export async function deleteConversationRecordsForPerson(personId: string): Promise<number> {
  const plural = CONVERSATION_OBJECT.namePlural;
  const P = pascal(CONVERSATION_OBJECT.nameSingular);
  let deleted = 0;
  for (let round = 0; round < 50; round++) {
    let ids: string[];
    try {
      const data = await twentyQuery<Record<string, { edges: { node: { id: string } }[] }>>(
        `query LinkedInConsoleConvRecords($filter: ${P}FilterInput) {
          ${plural}(first: 50, filter: $filter) { edges { node { id } } }
        }`,
        { filter: { personId: { eq: personId } } },
      );
      ids = (data[plural]?.edges ?? []).map((e) => e.node.id);
    } catch (err) {
      // The custom object (or its person relation) isn't in this workspace: nothing to delete.
      if (/cannot query field|unknown (type|argument|object)|does not exist|not found/i.test((err as Error).message)) return deleted;
      throw err;
    }
    if (!ids.length) break;
    for (const id of ids) {
      try {
        await twentyQuery(`mutation LinkedInConsoleDeleteConvRecord($id: UUID!) { delete${P}(id: $id) { id } }`, { id });
        deleted++;
      } catch (err) {
        if (/not found|does not exist|no record/i.test((err as Error).message)) continue;
        throw err;
      }
    }
    if (ids.length < 50) break;
  }
  return deleted;
}

/** Note and task bodies: one paragraph per blank-line-separated block (Twenty's rich text). */
const paragraphs = (markdown: string) =>
  JSON.stringify(
    markdown.split('\n\n').map((para, i) => ({
      id: String(i + 1),
      type: 'paragraph',
      props: { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' },
      content: [{ type: 'text', text: para, styles: {} }],
      children: [],
    })),
  );

export class PersonGoneError extends TwentyError {}

/** A note on a person. If linking fails (the person was deleted or merged), the note is removed again. */
export async function addPersonNote(personId: string, title: string, markdown: string) {
  const note = await twentyQuery<{ createNote: { id: string } }>(
    `mutation LinkedInConsoleCreateNote($input: NoteCreateInput!) { createNote(data: $input) { id } }`,
    { input: { title: title.slice(0, 250), bodyV2: { blocknote: paragraphs(markdown), markdown } } },
  );
  const noteId = note.createNote.id;
  try {
    await twentyQuery(`mutation LinkedInConsoleLinkNote($input: NoteTargetCreateInput!) { createNoteTarget(data: $input) { id } }`, {
      input: { noteId, targetPersonId: personId },
    });
  } catch (err) {
    await twentyQuery(`mutation LinkedInConsoleDeleteNote($id: UUID!) { deleteNote(id: $id) { id } }`, { id: noteId }).catch(() => {});
    if (/foreign key|not found|does not exist/i.test((err as Error).message)) throw new PersonGoneError((err as Error).message);
    throw err;
  }
  return noteId;
}

// ---------- Tasks (follow-up reminders) ----------

export interface TaskInput {
  title: string;
  markdown: string;
  dueAt: Date;
  /** Twenty workspace member, or null for nobody in particular. */
  assigneeId: string | null;
}

/** A task on a person. If linking fails (the person was deleted or merged), the task is removed again. */
export async function createPersonTask(personId: string, t: TaskInput) {
  const created = await twentyQuery<{ createTask: { id: string } }>(
    `mutation LinkedInConsoleCreateTask($input: TaskCreateInput!) { createTask(data: $input) { id } }`,
    {
      input: {
        title: t.title.slice(0, 250),
        bodyV2: { blocknote: paragraphs(t.markdown), markdown: t.markdown },
        dueAt: t.dueAt.toISOString(),
        status: 'TODO',
        ...(t.assigneeId ? { assigneeId: t.assigneeId } : {}),
      },
    },
  );
  const taskId = created.createTask.id;
  try {
    await twentyQuery(`mutation LinkedInConsoleLinkTask($input: TaskTargetCreateInput!) { createTaskTarget(data: $input) { id } }`, {
      input: { taskId, targetPersonId: personId },
    });
  } catch (err) {
    await twentyQuery(`mutation LinkedInConsoleDeleteTask($id: UUID!) { deleteTask(id: $id) { id } }`, { id: taskId }).catch(() => {});
    if (/foreign key|not found|does not exist/i.test((err as Error).message)) throw new PersonGoneError((err as Error).message);
    throw err;
  }
  return taskId;
}

/** Updates a task; false when it no longer exists in Twenty (deleted there). */
export async function updateTask(taskId: string, data: Partial<TaskInput> & { done?: boolean }) {
  const input: Record<string, unknown> = {};
  if (data.title) input.title = data.title.slice(0, 250);
  if (data.markdown) input.bodyV2 = { blocknote: paragraphs(data.markdown), markdown: data.markdown };
  if (data.dueAt) input.dueAt = data.dueAt.toISOString();
  if (data.assigneeId !== undefined) input.assigneeId = data.assigneeId;
  if (data.done !== undefined) input.status = data.done ? 'DONE' : 'TODO';
  try {
    await twentyQuery(
      `mutation LinkedInConsoleUpdateTask($id: UUID!, $input: TaskUpdateInput!) { updateTask(id: $id, data: $input) { id } }`,
      {
        id: taskId,
        input,
      },
    );
    return true;
  } catch (err) {
    if (/not found|does not exist|no record/i.test((err as Error).message)) return false;
    throw err;
  }
}

/** Status and due date of these tasks; a task missing from the answer was deleted in Twenty. */
export async function tasksByIds(ids: string[]) {
  const data = await twentyQuery<{ tasks: { edges: { node: { id: string; status: string | null; dueAt: string | null } }[] } }>(
    `query LinkedInConsoleTasks($filter: TaskFilterInput) { tasks(filter: $filter, first: 100) { edges { node { id status dueAt } } } }`,
    { filter: { id: { in: ids } } },
  );
  return new Map(data.tasks.edges.map((e) => [e.node.id, e.node]));
}

/**
 * The display name of each of these Persons, by id (for the CRM bindings list). A Person missing from the answer
 * (deleted or merged in Twenty) simply isn't in the map. Fetched in chunks so a long list stays one query each.
 */
export async function peopleByIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100);
    const data = await twentyQuery<{
      people: { edges: { node: { id: string; name?: { firstName?: string | null; lastName?: string | null } | null } }[] };
    }>(
      `query LinkedInConsolePeopleByIds($filter: PersonFilterInput, $first: Int!) {
        people(filter: $filter, first: $first) { edges { node { id name { firstName lastName } } } }
      }`,
      { filter: { id: { in: chunk } }, first: chunk.length },
    );
    for (const { node } of data.people.edges)
      out.set(node.id, `${node.name?.firstName ?? ''} ${node.name?.lastName ?? ''}`.trim() || '(no name)');
  }
  return out;
}

// ---------- Choosing a Person (bind to existing / add as new) ----------

export interface PersonCandidate {
  id: string;
  name: string;
  jobTitle: string | null;
  company: string | null;
  city: string | null;
  email: string | null;
  linkedin: string | null;
  owner: string | null;
}

type PersonNode = {
  id: string;
  name?: { firstName?: string | null; lastName?: string | null } | null;
  jobTitle?: string | null;
  city?: string | null;
  emails?: { primaryEmail?: string | null } | null;
  linkedinLink?: { primaryLinkUrl?: string | null } | null;
  company?: { name?: string | null } | null;
  [owner: string]: unknown;
};

const candidate = (n: PersonNode, ownerField: string | null): PersonCandidate => {
  const owner = ownerField ? (n[ownerField] as { name?: { firstName?: string; lastName?: string } } | null) : null;
  return {
    id: n.id,
    name: `${n.name?.firstName ?? ''} ${n.name?.lastName ?? ''}`.trim() || '(no name)',
    jobTitle: n.jobTitle ?? null,
    company: n.company?.name ?? null,
    city: n.city ?? null,
    email: n.emails?.primaryEmail ?? null,
    linkedin: n.linkedinLink?.primaryLinkUrl ?? null,
    owner: owner?.name ? `${owner.name.firstName ?? ''} ${owner.name.lastName ?? ''}`.trim() || null : null,
  };
};

/**
 * People to bind a prospect to, for a teammate to choose from: every word of the search in the first name, last
 * name or email, plus everyone with the prospect's LinkedIn link. Shows the owner when Person has the owner field.
 */
export async function searchPeople(q: string, profileUrl: string | null, ownerField: string | null): Promise<PersonCandidate[]> {
  const words = q
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[%_]/g, ''))
    .filter((w) => w.length >= 2)
    .slice(0, 4);
  const key = linkedinKey(profileUrl);
  const or: unknown[] = [];
  if (words.length) {
    or.push({
      and: words.map((w) => ({
        or: [
          { name: { firstName: { ilike: `%${w}%` } } },
          { name: { lastName: { ilike: `%${w}%` } } },
          { emails: { primaryEmail: { ilike: `%${w}%` } } },
        ],
      })),
    });
  }
  if (key) or.push({ linkedinLink: { primaryLinkUrl: { ilike: `%${key.replace(/[%_]/g, '')}%` } } });
  if (!or.length) return [];
  const ownerSelect = ownerField ? `${ownerField} { name { firstName lastName } }` : '';
  const data = await twentyQuery<{ people: { edges: { node: PersonNode }[] } }>(
    `query LinkedInConsoleSearchPeople($filter: PersonFilterInput) {
      people(filter: $filter, first: 15) {
        edges { node { id name { firstName lastName } jobTitle city emails { primaryEmail } linkedinLink { primaryLinkUrl }
          company { name } ${ownerSelect} } }
      }
    }`,
    { filter: { or } },
  );
  return data.people.edges.map((e) => candidate(e.node, ownerField));
}

/** One Person with its current owner (member id) and pod, or null when it doesn't exist. */
export async function personById(
  id: string,
  fields: { ownerField: string | null; podField: string | null },
): Promise<{ id: string; linkedin: string | null; ownerId: string | null; pod: string | null } | null> {
  const extra = [fields.ownerField ? `${fields.ownerField}Id` : '', fields.podField ?? ''].filter(Boolean).join(' ');
  const data = await twentyQuery<{ people: { edges: { node: Record<string, any> }[] } }>(
    `query LinkedInConsolePerson($filter: PersonFilterInput) {
      people(filter: $filter, first: 1) { edges { node { id linkedinLink { primaryLinkUrl } ${extra} } } }
    }`,
    { filter: { id: { eq: id } } },
  );
  const n = data.people.edges[0]?.node;
  if (!n) return null;
  return {
    id: n.id,
    linkedin: n.linkedinLink?.primaryLinkUrl ?? null,
    ownerId: fields.ownerField ? (n[`${fields.ownerField}Id`] ?? null) : null,
    pod: fields.podField ? (n[fields.podField] ?? null) : null,
  };
}

// ---------- Records of a custom object (the LinkedIn conversation object) ----------

const pascal = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

export async function createRecord(objectSingular: string, data: Record<string, unknown>) {
  const P = pascal(objectSingular);
  const r = await twentyQuery<Record<string, { id: string }>>(
    `mutation LinkedInConsoleCreateRecord($input: ${P}CreateInput!) { create${P}(data: $input) { id } }`,
    { input: data },
  );
  return r[`create${P}`].id;
}

/** Updates a record; false when it no longer exists (deleted in Twenty). */
export async function updateRecord(objectSingular: string, id: string, data: Record<string, unknown>) {
  const P = pascal(objectSingular);
  try {
    await twentyQuery(
      `mutation LinkedInConsoleUpdateRecord($id: UUID!, $input: ${P}UpdateInput!) { update${P}(id: $id, data: $input) { id } }`,
      {
        id,
        input: data,
      },
    );
    return true;
  } catch (err) {
    if (/not found|does not exist|no record/i.test((err as Error).message)) return false;
    throw err;
  }
}
