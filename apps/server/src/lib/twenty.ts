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
