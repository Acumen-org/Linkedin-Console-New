// The custom fields LinkedIn Console writes on Twenty's Person (master plan L3, L4 and the review mark), and
// how to check and add them through Twenty's metadata API (TWENTY_API_URL with /metadata instead of /graphql,
// same API key). Adding is only ever done by scripts/twenty-fields.sh after a look at the dry run; the sync
// never changes Twenty's data model by itself, and only writes a field that exists.
import { config } from './config.ts';
import { TwentyError } from './twenty.ts';

export interface FieldSpec {
  name: string;
  label: string;
  type: 'TEXT' | 'DATE_TIME' | 'SELECT';
  description: string;
  options?: { value: string; label: string; color: string }[];
}

export const LINKEDIN_STATUS = { CONNECTED: 'CONNECTED', REQUEST_SENT: 'REQUEST_SENT', NOT_CONNECTED: 'NOT_CONNECTED' } as const;
export const CONSOLE_SOURCE = { ADDED: 'LINKEDIN_CONSOLE', REVIEW: 'LINKEDIN_CONSOLE_REVIEW' } as const;

/** Phase 1 needs only the source (the review mark); the rest is written from Phase 3 on. */
export const PERSON_FIELDS: FieldSpec[] = [
  {
    name: 'linkedinConsoleSource',
    label: 'LinkedIn Console source',
    type: 'SELECT',
    description: 'Added by LinkedIn Console, or created by its earlier sync for someone who never replied (to review).',
    options: [
      { value: CONSOLE_SOURCE.ADDED, label: 'LinkedIn Console', color: 'blue' },
      { value: CONSOLE_SOURCE.REVIEW, label: 'LinkedIn Console: review', color: 'orange' },
    ],
  },
  {
    name: 'linkedinStatus',
    label: 'LinkedIn status',
    type: 'SELECT',
    description: 'Connection with the LinkedIn account that talks to them (LinkedIn Console).',
    options: [
      { value: LINKEDIN_STATUS.CONNECTED, label: 'Connected', color: 'green' },
      { value: LINKEDIN_STATUS.REQUEST_SENT, label: 'Request sent', color: 'yellow' },
      { value: LINKEDIN_STATUS.NOT_CONNECTED, label: 'Not connected', color: 'gray' },
    ],
  },
  {
    name: 'lastLinkedinMessageSentAt',
    label: 'Last LinkedIn message sent',
    type: 'DATE_TIME',
    description: 'When the team last messaged them on LinkedIn (LinkedIn Console).',
  },
  {
    name: 'lastLinkedinMessageReceivedAt',
    label: 'Last LinkedIn message received',
    type: 'DATE_TIME',
    description: 'When they last messaged the team on LinkedIn (LinkedIn Console).',
  },
  {
    name: 'linkedinMemberId',
    label: 'LinkedIn member ID',
    type: 'TEXT',
    description: "LinkedIn's id for this person: still matches after they rename their profile link (LinkedIn Console).",
  },
];

function metadataUrl() {
  if (!config.twenty) throw new TwentyError('Twenty CRM is not configured (TWENTY_API_URL, TWENTY_API_KEY)');
  return config.twenty.url.replace(/\/graphql\/?$/, '/metadata');
}

async function metadata<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(metadataUrl(), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.twenty!.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length)
    throw new TwentyError(`Twenty metadata: ${body.errors?.map((e) => e.message).join('; ') ?? res.status}`);
  return body.data as T;
}

/** The Person object's id and the names of the fields it has. */
export async function personFields(): Promise<{ objectId: string; fields: Map<string, string> }> {
  const data = await metadata<{
    objects: { edges: { node: { id: string; nameSingular: string; fields: { edges: { node: { name: string; type: string } }[] } } }[] };
  }>(`query LinkedInConsolePersonFields {
    objects(paging: { first: 200 }) {
      edges { node { id nameSingular fields(paging: { first: 1000 }) { edges { node { name type } } } } }
    }
  }`);
  const person = data.objects.edges.map((e) => e.node).find((o) => o.nameSingular === 'person');
  if (!person) throw new TwentyError('Twenty has no "person" object');
  return { objectId: person.id, fields: new Map(person.fields.edges.map((e) => [e.node.name, e.node.type])) };
}

/** Adds one field to Person (custom, nullable). */
export async function createPersonField(objectId: string, f: FieldSpec) {
  await metadata(
    `mutation LinkedInConsoleCreateField($input: CreateOneFieldMetadataInput!) { createOneField(input: $input) { id name } }`,
    {
      input: {
        field: {
          objectMetadataId: objectId,
          name: f.name,
          label: f.label,
          type: f.type,
          description: f.description,
          isNullable: true,
          ...(f.options ? { options: f.options.map((o, i) => ({ ...o, position: i })) } : {}),
        },
      },
    },
  );
}

let cache: { at: number; names: Set<string> } | null = null;
/** Whether Person has this field (asked at most every 10 minutes): the sync only writes fields that exist. */
export async function personHasField(name: string) {
  if (!cache || Date.now() - cache.at > 10 * 60_000) cache = { at: Date.now(), names: new Set((await personFields()).fields.keys()) };
  return cache.names.has(name);
}

/** Forget the cached field list (after adding fields in this process; tests). */
export const resetPersonFieldsCache = () => {
  cache = null;
};
