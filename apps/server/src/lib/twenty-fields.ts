// What LinkedIn Console adds to Twenty's data model, and how to check and add it through Twenty's metadata API
// (TWENTY_API_URL with /metadata instead of /graphql, same API key):
//  - fields on Person: the LinkedIn summary of the prospect (master plan L3, L4) and the review mark;
//  - a "LinkedIn conversation" object: one record per conversation (prospect × LinkedIn account), linked to the
//    Person, so the Person page lists them.
// Adding is only ever done by scripts/twenty-fields.sh after a look at the dry run; the sync never changes Twenty's
// data model by itself, and only writes what exists.
import { config } from './config.ts';
import { TwentyError } from './twenty.ts';

export interface FieldSpec {
  name: string;
  label: string;
  type: 'TEXT' | 'DATE_TIME' | 'SELECT' | 'LINKS' | 'NUMBER';
  description: string;
  options?: { value: string; label: string; color: string }[];
}

export const LINKEDIN_STATUS = { CONNECTED: 'CONNECTED', REQUEST_SENT: 'REQUEST_SENT', NOT_CONNECTED: 'NOT_CONNECTED' } as const;
export const CONSOLE_SOURCE = { ADDED: 'LINKEDIN_CONSOLE', REVIEW: 'LINKEDIN_CONSOLE_REVIEW' } as const;
/** Replied: their message is the latest; no reply yet: ours is (the inbox views of the same name). */
export const REPLY_STATUS = { REPLIED: 'REPLIED', NO_REPLY: 'NO_REPLY' } as const;

const replyStatusField = (name: string, label: string): FieldSpec => ({
  name,
  label,
  type: 'SELECT',
  description: 'Replied: their message is the latest. No reply yet: ours is (LinkedIn Console).',
  options: [
    { value: REPLY_STATUS.REPLIED, label: 'Replied', color: 'green' },
    { value: REPLY_STATUS.NO_REPLY, label: 'No reply yet', color: 'orange' },
  ],
});

/** The prospect's LinkedIn summary on their Person (over every conversation with them). */
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
    description: 'Connection with the LinkedIn account(s) that talk to them (LinkedIn Console).',
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
  replyStatusField('linkedinReplyStatus', 'LinkedIn reply status'),
  {
    name: 'nextLinkedinFollowUpAt',
    label: 'Next LinkedIn follow-up',
    type: 'DATE_TIME',
    description: 'The earliest open follow-up reminder for them (LinkedIn Console).',
  },
  {
    name: 'linkedinConversation',
    label: 'LinkedIn conversation',
    type: 'LINKS',
    description: 'Their latest conversation in LinkedIn Console.',
  },
];

/** One record per conversation (prospect × LinkedIn account), linked to the prospect's Person. */
export const CONVERSATION_OBJECT = {
  nameSingular: 'linkedinConversation',
  namePlural: 'linkedinConversations',
  labelSingular: 'LinkedIn conversation',
  labelPlural: 'LinkedIn conversations',
  description: 'A LinkedIn conversation with a prospect, through one of the team’s LinkedIn accounts (LinkedIn Console).',
  icon: 'IconBrandLinkedin',
  fields: [
    { name: 'linkedinAccount', label: 'LinkedIn account', type: 'TEXT', description: 'The team’s LinkedIn account in this conversation.' },
    {
      name: 'handledBy',
      label: 'Handled by',
      type: 'TEXT',
      description: 'The teammate the conversation is assigned to, else the last one who messaged.',
    },
    replyStatusField('replyStatus', 'Reply status'),
    {
      name: 'lastMessageSentAt',
      label: 'Last message sent',
      type: 'DATE_TIME',
      description: 'When the team last wrote in this conversation.',
    },
    {
      name: 'lastMessageReceivedAt',
      label: 'Last message received',
      type: 'DATE_TIME',
      description: 'When the prospect last wrote in this conversation.',
    },
    {
      name: 'nextFollowUpAt',
      label: 'Next follow-up',
      type: 'DATE_TIME',
      description: 'The open follow-up reminder of this conversation.',
    },
    { name: 'messageCount', label: 'Messages', type: 'NUMBER', description: 'Messages in this conversation.' },
    { name: 'conversationLink', label: 'Open in LinkedIn Console', type: 'LINKS', description: 'This conversation in LinkedIn Console.' },
  ] as FieldSpec[],
  /** The relation to Person (Person gets the list of its LinkedIn conversations). */
  relation: { name: 'person', label: 'Person', targetLabel: 'LinkedIn conversations', icon: 'IconUser' },
} as const;

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

export interface ObjectInfo {
  id: string;
  fields: Map<string, string>;
}

/** Every object (by singular name) with its id and its fields' names and types. */
export async function objectsSchema(): Promise<Map<string, ObjectInfo>> {
  const data = await metadata<{
    objects: { edges: { node: { id: string; nameSingular: string; fields: { edges: { node: { name: string; type: string } }[] } } }[] };
  }>(`query LinkedInConsolePersonFields {
    objects(paging: { first: 200 }) {
      edges { node { id nameSingular fields(paging: { first: 1000 }) { edges { node { name type } } } } }
    }
  }`);
  return new Map(
    data.objects.edges.map(({ node }) => [
      node.nameSingular,
      { id: node.id, fields: new Map(node.fields.edges.map((e) => [e.node.name, e.node.type])) },
    ]),
  );
}

/** The Person object's id and the names of the fields it has. */
export async function personFields(): Promise<{ objectId: string; fields: Map<string, string> }> {
  const person = (await objectsSchema()).get('person');
  if (!person) throw new TwentyError('Twenty has no "person" object');
  return { objectId: person.id, fields: person.fields };
}

/** Adds one field to an object (custom, nullable). */
export async function createField(objectId: string, f: FieldSpec) {
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
export const createPersonField = createField;

/** Adds the LinkedIn conversation object (it comes with Twenty's standard fields, e.g. its name). */
export async function createConversationObject() {
  const o = CONVERSATION_OBJECT;
  const data = await metadata<{ createOneObject: { id: string } }>(
    `mutation LinkedInConsoleCreateObject($input: CreateOneObjectInput!) { createOneObject(input: $input) { id } }`,
    {
      input: {
        object: {
          nameSingular: o.nameSingular,
          namePlural: o.namePlural,
          labelSingular: o.labelSingular,
          labelPlural: o.labelPlural,
          description: o.description,
          icon: o.icon,
        },
      },
    },
  );
  return data.createOneObject.id;
}

/** Links the conversation object to Person: many conversations, one Person. */
export async function createConversationRelation(objectId: string, personObjectId: string) {
  const r = CONVERSATION_OBJECT.relation;
  await metadata(
    `mutation LinkedInConsoleCreateField($input: CreateOneFieldMetadataInput!) { createOneField(input: $input) { id name } }`,
    {
      input: {
        field: {
          objectMetadataId: objectId,
          name: r.name,
          label: r.label,
          type: 'RELATION',
          icon: r.icon,
          isNullable: true,
          relationCreationPayload: {
            type: 'MANY_TO_ONE',
            targetObjectMetadataId: personObjectId,
            targetFieldLabel: r.targetLabel,
            targetFieldIcon: CONVERSATION_OBJECT.icon,
          },
        },
      },
    },
  );
}

let cache: { at: number; objects: Map<string, ObjectInfo> } | null = null;
/** The data model (asked at most every 10 minutes): only fields and objects that exist are written. */
async function schema() {
  if (!cache || Date.now() - cache.at > 10 * 60_000) cache = { at: Date.now(), objects: await objectsSchema() };
  return cache.objects;
}
export async function personHasField(name: string) {
  return !!(await schema()).get('person')?.fields.has(name);
}
/** The field's type (e.g. RELATION, TEXT, SELECT), or null when Person doesn't have it. */
export async function personFieldType(name: string) {
  return (await schema()).get('person')?.fields.get(name) ?? null;
}
/** The conversation object's fields, when it exists with its link to Person (else null: nothing is written). */
export async function conversationObjectFields(): Promise<Set<string> | null> {
  const o = (await schema()).get(CONVERSATION_OBJECT.nameSingular);
  return o?.fields.has(CONVERSATION_OBJECT.relation.name) ? new Set(o.fields.keys()) : null;
}

/** Forget the cached data model (after adding to it in this process; tests). */
export const resetPersonFieldsCache = () => {
  cache = null;
};

export interface FieldReport {
  scope: 'person' | 'object';
  name: string;
  label: string;
  status: 'exists' | 'added' | 'missing';
}

/**
 * Check (and with `apply`, add) everything LinkedIn Console needs in Twenty: the Person fields, the LinkedIn
 * conversation object, its fields and its link to Person. Custom, nullable; nothing existing is ever changed.
 * Shared by the CLI (scripts/twenty-fields.sh) and the admin Settings UI.
 */
export async function syncTwentyFields(apply: boolean): Promise<{ items: FieldReport[]; missing: number }> {
  const objects = await objectsSchema();
  const person = objects.get('person');
  if (!person) throw new TwentyError('Twenty has no "person" object');
  const items: FieldReport[] = [];
  let missing = 0;
  const ensure = async (objectId: string | null, have: Map<string, string>, fields: FieldSpec[], scope: 'person' | 'object') => {
    for (const f of fields) {
      if (have.get(f.name)) {
        items.push({ scope, name: f.name, label: f.label, status: 'exists' });
        continue;
      }
      missing++;
      if (apply && objectId) {
        await createField(objectId, f);
        items.push({ scope, name: f.name, label: f.label, status: 'added' });
      } else {
        items.push({ scope, name: f.name, label: f.label, status: 'missing' });
      }
    }
  };
  await ensure(person.id, person.fields, PERSON_FIELDS, 'person');

  const o = CONVERSATION_OBJECT;
  let conv = objects.get(o.nameSingular);
  if (!conv) {
    missing++;
    if (apply) {
      const id = await createConversationObject();
      conv = (await objectsSchema()).get(o.nameSingular) ?? { id, fields: new Map() };
      items.push({ scope: 'object', name: o.nameSingular, label: o.labelPlural, status: 'added' });
    } else {
      items.push({ scope: 'object', name: o.nameSingular, label: o.labelPlural, status: 'missing' });
    }
  } else {
    items.push({ scope: 'object', name: o.nameSingular, label: o.labelPlural, status: 'exists' });
  }
  await ensure(conv?.id ?? null, conv?.fields ?? new Map(), o.fields, 'object');
  if (conv?.fields.has(o.relation.name)) {
    items.push({ scope: 'object', name: o.relation.name, label: 'link to Person', status: 'exists' });
  } else {
    missing++;
    if (apply && conv) {
      await createConversationRelation(conv.id, person.id);
      items.push({ scope: 'object', name: o.relation.name, label: 'link to Person', status: 'added' });
    } else {
      items.push({ scope: 'object', name: o.relation.name, label: 'link to Person', status: 'missing' });
    }
  }
  resetPersonFieldsCache();
  return { items, missing };
}
