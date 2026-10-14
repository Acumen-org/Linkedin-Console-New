// Twenty CRM over GraphQL (TWENTY_API_URL = https://…/graphql, TWENTY_API_KEY = an API key from Twenty).
// The same values the Twilio console uses.
import { config } from './config.ts';

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

/** Twenty's web address: the API address without /graphql. */
export const twentyWebUrl = () => (config.twenty ? config.twenty.url.replace(/\/graphql\/?$/, '') : null);

type PeopleResult = { people: { edges: { node: { id: string; linkedinLink?: { primaryLinkUrl?: string | null } | null } }[] } };

const FIND_PEOPLE = `
  query LinkedInConsoleFindPeople($filter: PersonFilterInput) {
    people(filter: $filter, first: 2) { edges { node { id linkedinLink { primaryLinkUrl } } } }
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
 * The Twenty person for a prospect: by LinkedIn profile link, else by exact name when exactly one person has
 * it and no other LinkedIn profile, else a new person. Returns the id.
 */
export async function findOrCreatePerson(p: { name: string; profileUrl: string | null; headline: string | null }) {
  const key = linkedinKey(p.profileUrl);
  if (key) {
    const byLink = await twentyQuery<PeopleResult>(FIND_PEOPLE, {
      filter: { linkedinLink: { primaryLinkUrl: { ilike: `%${key.replace(/[%_]/g, '')}%` } } },
    });
    const hit = byLink.people.edges.find((e) => linkedinKey(e.node.linkedinLink?.primaryLinkUrl) === key);
    if (hit) return { id: hit.node.id, created: false };
  }
  const [firstName, ...rest] = p.name.trim().split(/\s+/);
  const lastName = rest.join(' ');
  if (firstName && p.name !== 'LinkedIn Member') {
    const byName = await twentyQuery<PeopleResult>(FIND_PEOPLE, {
      filter: { and: [{ name: { firstName: { eq: firstName } } }, { name: { lastName: { eq: lastName } } }] },
    });
    const only = byName.people.edges.length === 1 ? byName.people.edges[0].node : null;
    const otherProfile = only && linkedinKey(only.linkedinLink?.primaryLinkUrl);
    if (only && (!otherProfile || otherProfile === key)) return { id: only.id, created: false };
  }
  const created = await twentyQuery<{ createPerson: { id: string } }>(
    `mutation LinkedInConsoleCreatePerson($input: PersonCreateInput!) { createPerson(data: $input) { id } }`,
    {
      input: {
        name: { firstName: firstName || 'LinkedIn', lastName: firstName ? lastName : 'Member' },
        ...(p.profileUrl ? { linkedinLink: { primaryLinkUrl: p.profileUrl, primaryLinkLabel: 'LinkedIn' } } : {}),
        ...(p.headline ? { jobTitle: p.headline.slice(0, 250) } : {}),
      },
    },
  );
  return { id: created.createPerson.id, created: true };
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
