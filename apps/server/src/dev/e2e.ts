// End-to-end test of api + worker + database + Redis, with a fake bridge (no LinkedIn, no pod).
//   docker compose exec api node src/dev/e2e.ts
// Creates temporary users/account and removes them afterwards. Exit code 0 = all passed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { Redis } from 'ioredis';
import { hashPassword } from '../core/auth.ts';
import { runStaffSync } from '../core/staff-sync.ts';
import { config } from '../lib/config.ts';
import { sql } from '../lib/db.ts';
import { newAccountId, newId } from '../lib/ids.ts';

const API = `http://localhost:${config.port}`;
const tag = crypto.randomBytes(3).toString('hex');
const SELF = `urn:li:fsd_profile:E2ESELF${tag}`;
const conv = (id: string) => `urn:li:msg_conversation:(${SELF},2-${id}${tag})`;
const redis = new Redis(config.redisUrl);
const blocking = new Redis(config.redisUrl);
const results: { name: string; ok: boolean; error?: string }[] = [];

// Fake Twilio console staff list (GET /api/staff, GET /api/staff/:id), for the staff sync tests.
type FakeStaff = {
  id: string;
  name: string;
  email: string;
  email_aliases?: string[];
  resigned_at?: string | null;
  auto_imported?: boolean;
};
let staffList: FakeStaff[] = [];
const staffById = new Map<string, FakeStaff & { archived_at?: string }>();
function fakeTwilio(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers.authorization !== `Bearer ${config.staffSync.apiKey}`) return res.writeHead(401).end();
  const one = req.url?.match(/^\/api\/staff\/([^/?]+)$/);
  const found = one ? staffById.get(decodeURIComponent(one[1])) : null;
  if (one && !found) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(found ?? staffList));
}

// Fake Twenty CRM (POST /graphql): workspace members, two per page (the sync must read every page).
let twentyMembers: { id: string; name: string; email: string }[] = [];
let twentyFails = false;
const twentyPeople: { id: string; firstName: string; lastName: string; linkedin: string | null; jobTitle?: string | null }[] = [];
let twentyNotes: { id: string; title: string; markdown: string; personId: string | null }[] = [];
function fakeTwenty(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.headers.authorization !== `Bearer ${config.twenty?.apiKey}`) return res.writeHead(401).end();
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { query, variables } = JSON.parse(body);
    const json = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (twentyFails) return json({ errors: [{ message: 'Forbidden resource' }] });
    const q = String(query);
    if (q.includes('LinkedInConsoleFindPeople')) {
      const f = variables.filter;
      const link = f.linkedinLink?.primaryLinkUrl?.ilike?.replaceAll('%', '').toLowerCase();
      const first = f.and?.[0]?.name?.firstName?.eq;
      const last = f.and?.[1]?.name?.lastName?.eq;
      const hits = twentyPeople.filter((x) =>
        link ? (x.linkedin ?? '').toLowerCase().includes(link) : x.firstName === first && x.lastName === last,
      );
      return json({ data: { people: { edges: hits.map((x) => ({ node: { id: x.id, linkedinLink: { primaryLinkUrl: x.linkedin } } })) } } });
    }
    if (q.includes('LinkedInConsoleCreatePerson')) {
      const i = variables.input;
      const person = {
        id: crypto.randomUUID(),
        firstName: i.name.firstName,
        lastName: i.name.lastName,
        linkedin: i.linkedinLink?.primaryLinkUrl ?? null,
        jobTitle: i.jobTitle ?? null,
      };
      twentyPeople.push(person);
      return json({ data: { createPerson: { id: person.id } } });
    }
    if (q.includes('LinkedInConsoleCreateNote')) {
      const note = {
        id: crypto.randomUUID(),
        title: variables.input.title,
        markdown: variables.input.bodyV2.markdown,
        personId: null as string | null,
      };
      twentyNotes.push(note);
      return json({ data: { createNote: { id: note.id } } });
    }
    if (q.includes('LinkedInConsoleLinkNote')) {
      const { noteId, targetPersonId } = variables.input;
      if (!twentyPeople.some((x) => x.id === targetPersonId))
        return json({ errors: [{ message: 'insert or update on table "noteTarget" violates foreign key constraint' }] });
      const note = twentyNotes.find((n) => n.id === noteId);
      if (note) note.personId = targetPersonId;
      return json({ data: { createNoteTarget: { id: crypto.randomUUID() } } });
    }
    if (q.includes('LinkedInConsoleDeleteNote')) {
      twentyNotes = twentyNotes.filter((n) => n.id !== variables.id);
      return json({ data: { deleteNote: { id: variables.id } } });
    }
    if (!q.includes('workspaceMembers')) return json({ errors: [{ message: 'unknown query' }] });
    const start = variables?.after ? Number(variables.after) : 0;
    const page = twentyMembers.slice(start, start + 2);
    json({
      data: {
        workspaceMembers: {
          edges: page.map((m) => {
            const [firstName, lastName] = m.name.split(' ');
            return { node: { id: m.id, name: { firstName, lastName }, userEmail: m.email } };
          }),
          pageInfo: { hasNextPage: start + 2 < twentyMembers.length, endCursor: String(start + 2) },
        },
      },
    });
  });
}

// Webhook receiver inside this process; the worker container reaches it by this container's hostname.
const received: { event: string; signature: string; legacySignature: string; body: string }[] = [];
const receiver = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/staff')) return fakeTwilio(req, res);
  if (req.url === '/graphql') return fakeTwenty(req, res);
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({
      event: String(req.headers['x-linkedin-console-event']),
      signature: String(req.headers['x-linkedin-console-signature']),
      legacySignature: String(req.headers['x-linkunify-signature']),
      body,
    });
    res.end('ok');
  });
});
await new Promise<void>((r) => receiver.listen(4100, '0.0.0.0', () => r()));
const WEBHOOK_URL = `http://${os.hostname()}:4100/hook`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- tiny HTTP client with a cookie per user ----------
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const form = body instanceof FormData;
    const res = await fetch(API + path, {
      method,
      headers: { ...(body !== undefined && !form ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: form ? body : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const json = res.headers.get('content-type')?.includes('json');
    const text = json ? '' : await res.text();
    const data = json ? await res.json() : null;
    return { status: res.status, data: data as any, text, headers: res.headers };
  };
  return Object.assign(call, { cookie: () => cookie });
}

// Through Caddy, as a browser sees the app (CADDY_URL=off skips this when Caddy isn't running).
const CADDY = process.env.CADDY_URL ?? 'http://caddy';

async function until<T>(fn: () => Promise<T>, check: (v: T) => boolean, what: string, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (check(last)) return last;
    await sleep(250);
  } while (Date.now() < end);
  throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last).slice(0, 1500)}`);
}

const until_ = until;

async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: (e as Error).message });
    console.log(`✘ ${name}\n    ${(e as Error).message}`);
  }
}

// ---------- fixtures ----------
const ownerId = newId('usr');
const memberId = newId('usr');
const readerId = newId('usr');
const accountId = newAccountId();
const password = `E2E-${crypto.randomBytes(8).toString('hex')}`;
const emit = (type: string, data: unknown) =>
  redis.xadd('li:events', '*', 'json', JSON.stringify({ accountId, type, data, at: Date.now() }));
const person = (urn: string, name: string) => ({ urn, name, headline: `${name} headline`, avatarUrl: null, profileUrl: null });
const jane = person(`urn:li:fsd_profile:JANE${tag}`, 'Jane E2E');
const raj = person(`urn:li:fsd_profile:RAJ${tag}`, 'Raj E2E');
let seq = 0;
const msg = (c: string, from: typeof jane | null, text: string, at: number, extra = {}) => ({
  urn: `urn:li:msg_message:(${SELF},2-E2E${tag}${++seq})`,
  conversationUrn: conv(c),
  text,
  sentAt: at,
  senderUrn: from?.urn ?? SELF,
  senderName: from?.name ?? 'Self',
  senderAvatarUrl: null,
  fromSelf: !from,
  attachments: [],
  reactions: [],
  ...extra,
});

// Command results travel on their own stream, like the real bridge sends them.
const emitResult = (data: unknown) =>
  redis.xadd('li:results', '*', 'json', JSON.stringify({ accountId, type: 'result', data, at: Date.now() }));

// Fake bridge: records commands; confirms sends like LinkedIn would. The text prefix picks the scenario:
//   (none)        LinkedIn's copy first, then the result (UI send)
//   [fast]        result first without URN, LinkedIn's copy a moment later (direct send)
//   [late]        "could not confirm" first, LinkedIn's copy afterwards
//   [failafter]   LinkedIn's copy first, then a failure report
//   [anon]        direct send whose only copy names no sender (looks incoming)
//   [silent]      nothing at all (browser offline)
//   [limited]     LinkedIn shows a limit warning: failure with warning 'limited'
const commands: any[] = [];
let stopBridge = false;
async function fakeBridge() {
  let last = '$';
  while (!stopBridge) {
    const res = (await blocking.xread('BLOCK', 1000, 'STREAMS', `li:cmd:${accountId}`, last)) as [string, [string, string[]][]][] | null;
    for (const [id, fields] of res?.[0]?.[1] ?? []) {
      last = id;
      const cmd = JSON.parse(fields[1]);
      commands.push(cmd);
      // History syncs are confirmed like the real bridge does (the conversation's history is then "in").
      if (cmd.type === 'sync_thread')
        await emitResult({ cmdId: cmd.cmdId, type: cmd.type, ok: true, conversationUrn: cmd.conversationUrn });
      if (cmd.type !== 'send_message' || cmd.text.startsWith('[silent]')) continue;
      const echo = msg(cmd.threadId.replace(/^2-/, '').replace(tag, ''), null, cmd.text, Date.now());
      const ok = { cmdId: cmd.cmdId, type: cmd.type, ok: true };
      const failed = { cmdId: cmd.cmdId, type: cmd.type, ok: false, error: 'Could not confirm the message was sent' };
      if (cmd.text.startsWith('[fast]')) {
        await emitResult(ok);
        setTimeout(() => emit('messages', [echo]), 200);
      } else if (cmd.text.startsWith('[limited]')) {
        await emitResult({ ...failed, error: "LinkedIn: You've reached the weekly limit", warning: 'limited' });
      } else if (cmd.text.startsWith('[late]')) {
        await emitResult(failed);
        setTimeout(() => emit('messages', [echo]), 500);
      } else if (cmd.text.startsWith('[anon]')) {
        await emitResult(ok);
        await emit('messages', [{ ...echo, fromSelf: false, senderUrn: null, senderName: null }]);
      } else if (cmd.text.startsWith('[failafter]')) {
        await emit('messages', [echo]);
        setTimeout(() => emitResult(failed), 500);
      } else {
        await emit('messages', [echo]);
        setTimeout(() => emitResult({ ...ok, messageUrn: echo.urn }), 300); // without holding up the next command
      }
    }
  }
}

const rajInTwenty = crypto.randomUUID();
twentyPeople.push({ id: rajInTwenty, firstName: 'Raj', lastName: 'E2E', linkedin: null });

async function setup() {
  const hash = await hashPassword(password);
  await sql`INSERT INTO users (id, email, name, password_hash, role) VALUES
    (${ownerId}, ${`owner-${tag}@e2e.test`}, 'E2E Owner', ${hash}, 'ADMIN'),
    (${memberId}, ${`member-${tag}@e2e.test`}, 'E2E Member', ${hash}, 'MEMBER'),
    (${readerId}, ${`reader-${tag}@e2e.test`}, 'E2E Reader', ${hash}, 'MEMBER')`;
  await sql`INSERT INTO accounts (id, label, owner_user_id, status, timezone, language, last_seen_at, daily_send_cap)
            VALUES (${accountId}, 'E2E account', ${ownerId}, 'PROVISIONING', 'America/Chicago', 'en-US', now(), 80)`;
  await sql`INSERT INTO account_grants (account_id, user_id, level) VALUES (${accountId}, ${memberId}, 'REPLY'), (${accountId}, ${readerId}, 'READ')`;
}

async function cleanup() {
  stopBridge = true;
  receiver.close();
  await sql`DELETE FROM webhooks WHERE url = ${WEBHOOK_URL}`;
  await sql`DELETE FROM labels WHERE name LIKE ${`e2e-${tag}%`}`;
  await sql`DELETE FROM accounts WHERE id = ${accountId}`;
  await sql`DELETE FROM users WHERE id IN ${sql([ownerId, memberId, readerId])} OR email LIKE ${`%${tag}@e2e.test`}`;
  await redis.del(`li:cmd:${accountId}`, `lu:connsync:${accountId}`);
}

// ---------- run ----------
const owner = client();
const member = client();
const reader = client();
const now = Date.now();

try {
  await setup();
  fakeBridge();
  const login = async (c: ReturnType<typeof client>, who: string) =>
    assert.equal((await c('POST', '/api/auth/login', { email: `${who}-${tag}@e2e.test`, password })).status, 200);
  await login(owner, 'owner');
  await login(member, 'member');
  await login(reader, 'reader');

  let janeId = '';
  let janeContactId = '';
  let rajId = '';

  await step('session event marks account CONNECTED with profile', async () => {
    await emit('session', {
      status: 'CONNECTED',
      self: { urn: SELF, name: 'E2E Self', headline: 'Tester', publicId: 'e2e', avatarUrl: null },
    });
    const a = await until(
      () => owner('GET', `/api/accounts/${accountId}`),
      (r) => r.data?.status === 'CONNECTED',
      'CONNECTED',
    );
    assert.equal(a.data.displayName, 'E2E Self');
  });

  await step('conversations + messages sync into the unified inbox', async () => {
    await emit('conversations', [
      {
        urn: conv('JANE'),
        threadId: `2-JANE${tag}`,
        title: null,
        isGroup: false,
        unreadCount: 1,
        lastActivityAt: now - 60_000,
        folder: 'focused',
        participants: [jane],
      },
      {
        urn: conv('RAJ'),
        threadId: `2-RAJ${tag}`,
        title: null,
        isGroup: false,
        unreadCount: 0,
        lastActivityAt: now - 3_600_000,
        folder: 'other',
        participants: [raj],
      },
    ]);
    // Deliberately out of order: newest first, then an older one.
    await emit('messages', [
      msg('JANE', jane, 'Newest from Jane', now - 60_000, {
        attachments: [{ kind: 'file', name: 'deck.pdf', size: 10, mime: 'application/pdf', url: null }],
      }),
      msg('JANE', jane, 'Old hello from Jane', now - 600_000),
      msg('RAJ', raj, 'Hi from Raj', now - 3_600_000),
    ]);
    const list = await until(
      () => owner('GET', `/api/conversations?accountId=${accountId}&view=all`),
      (r) => r.data?.length === 2 && r.data.some((c: any) => c.lastMessagePreview === 'Newest from Jane'),
      'both conversations in All',
    );
    // "All" = every non-archived conversation (LinkedIn's Focused + Other), newest first.
    assert.deepEqual(
      list.data.map((c: any) => c.participants[0].name),
      ['Jane E2E', 'Raj E2E'],
    );
    janeId = list.data[0].id;
    const other = await owner('GET', `/api/conversations?accountId=${accountId}&view=other`);
    rajId = other.data[0]?.id;
    assert.ok(rajId, 'Raj conversation in "other" view');
    const jane1 = await until(
      () => owner('GET', `/api/conversations/${janeId}`),
      (r) => r.data?.lastMessagePreview === 'Newest from Jane',
      'preview',
    );
    assert.equal(jane1.data.unreadCount, 1, 'unread should follow LinkedIn (1), not be inflated by older messages');
    const msgs = await until(
      () => owner('GET', `/api/conversations/${janeId}/messages`),
      (r) => r.data?.length === 2,
      'both Jane messages',
    );
    assert.deepEqual(
      msgs.data.map((m: any) => m.text),
      ['Old hello from Jane', 'Newest from Jane'],
    );
    assert.equal(msgs.data[1].attachments[0].name, 'deck.pdf');
  });

  await step('history sync was requested for new conversations', async () => {
    await until(
      async () => commands.filter((c) => c.type === 'sync_thread').length,
      (n) => n >= 2,
      'sync_thread commands',
    );
  });

  await step('first sync: 100 recent chats, their history, then all connections, with progress', async () => {
    const accountSync = async () => (await owner('GET', `/api/accounts/${accountId}`)).data.sync;
    // Started when the account connected: the conversation list (target 100) and a quick pass of connections.
    assert.ok(commands.some((c) => c.type === 'sync_inbox' && c.target === 100));
    assert.ok(commands.some((c) => c.type === 'sync_connections' && c.progress && c.maxScrolls <= 10));
    assert.equal((await accountSync()).conversations.target, 100);

    // The bridge loaded the list: progress, then done.
    await emit('progress', { kind: 'conversations', loaded: 2, total: 100, done: false });
    const inbox = commands.find((c) => c.type === 'sync_inbox' && c.target);
    await emitResult({ cmdId: inbox.cmdId, type: 'sync_inbox', ok: true });
    // Each requested history was confirmed by the (fake) bridge: chats are complete, so the full list starts.
    const chats = await until(
      accountSync,
      (sync) => sync?.conversations.done && sync.history.total >= 2 && sync.history.done === sync.history.total,
      'chats done',
    );
    assert.equal(chats.connections.done, false);
    const full = await until(
      async () => commands.find((c) => c.type === 'sync_connections' && c.maxScrolls > 100),
      (c) => !!c,
      'full connection sync requested after the chats',
    );

    // Connections arrive with LinkedIn's total: an estimate appears, then the list completes.
    await emit('progress', { kind: 'connections', loaded: 40, total: 400, done: false });
    const quick = commands.find((c) => c.type === 'sync_connections' && c.maxScrolls <= 10);
    await emitResult({ cmdId: quick.cmdId, type: 'sync_connections', ok: true });
    const midway = await until(accountSync, (sync) => sync?.connections.loaded === 40, 'connections progress');
    assert.equal(midway.connections.total, 400);
    assert.equal(midway.finishedAt, null);
    await emit('progress', { kind: 'connections', loaded: 400, total: 400, done: false });
    await emitResult({ cmdId: full.cmdId, type: 'sync_connections', ok: true });
    const finished = await until(accountSync, (sync) => !!sync?.finishedAt, 'first sync finished');
    assert.equal(finished.connections.done, true);
  });

  await step('sync report: recent chats, which have their history, why the others wait, retry', async () => {
    const report = async () => (await owner('GET', `/api/accounts/${accountId}/sync-report`)).data;
    const done = await report();
    assert.equal(done.recent.count, 2);
    assert.equal(done.recent.withHistory, 2, JSON.stringify(done.chats));
    assert.equal(done.connections >= 0, true);
    assert.ok(done.sync.finishedAt, 'first sync finished');
    assert.deepEqual(
      done.chats.map((c: any) => c.waiting),
      [null, null],
    );
    assert.equal((await reader('GET', `/api/accounts/${accountId}/sync-report`)).status, 403, 'READ access cannot see it');

    // Raj's history never came: the report says why, and a retry asks LinkedIn again (once a minute at most).
    await sql`UPDATE conversations SET history_synced_at = NULL, history_requested_at = now() - interval '20 minutes' WHERE id = ${rajId}`;
    const waiting = await report();
    assert.equal(waiting.recent.waiting, 1);
    assert.equal(waiting.chats.find((c: any) => c.id === rajId).waiting, 'retrying');
    assert.equal((await member('POST', `/api/accounts/${accountId}/sync-report/retry`)).status, 403, 'full access only');
    const before = commands.length;
    const retry = await owner('POST', `/api/accounts/${accountId}/sync-report/retry`);
    assert.equal(retry.data.requested, 1);
    await until(
      async () => commands.slice(before).find((c) => c.type === 'sync_thread' && c.conversationUrn === conv('RAJ')),
      Boolean,
      'history asked again',
    );
    assert.equal((await owner('POST', `/api/accounts/${accountId}/sync-report/retry`)).status, 429);
    await until(report, (x) => x.recent.waiting === 0, 'history back in');
  });

  await step('opening a conversation whose history is not in yet fetches it first', async () => {
    await sql`UPDATE conversations SET history_synced_at = NULL WHERE id = ${rajId}`;
    await redis.del(`lu:prioritysync:${rajId}`);
    const before = commands.length;
    await owner('GET', `/api/conversations/${rajId}/messages`);
    const cmd = await until(
      async () => commands.slice(before).find((c) => c.type === 'sync_thread' && c.priority),
      (c) => !!c,
      'priority history request',
    );
    assert.equal(cmd.conversationUrn, conv('RAJ'));
    await until(
      async () => (await sql`SELECT history_synced_at FROM conversations WHERE id = ${rajId}`)[0].historySyncedAt,
      (t) => !!t,
      'history confirmed',
    );
  });

  await step('search finds messages by text', async () => {
    const r = await owner('GET', `/api/conversations?accountId=${accountId}&view=all&q=${encodeURIComponent('hello')}`);
    assert.equal(r.data.length, 1);
  });

  await step('name search matches names only (not the field names or URNs inside participant data)', async () => {
    const search = async (term: string) =>
      (await owner('GET', `/api/conversations?accountId=${accountId}&view=all&q=${encodeURIComponent(term)}`)).data.length;
    assert.equal(await search('Raj E2E'), 1);
    assert.equal(await search('fsd_profile'), 0, 'URNs are not names');
    assert.equal(await search('avatarUrl'), 0, 'field names are not names');
    assert.equal(await search('100%'), 0, '% is a literal character, not a wildcard');
  });

  await step('sending: queued → SENT, merged with LinkedIn copy, attributed to teammate', async () => {
    const clientId = crypto.randomUUID();
    const sent = await member('POST', `/api/conversations/${janeId}/messages`, { text: 'Reply from member', clientId });
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    assert.equal(sent.data.status, 'QUEUED');
    const after = await until(
      () => member('GET', `/api/conversations/${janeId}/messages`),
      (r) => r.data.some((m: any) => m.clientId === clientId && m.status === 'SENT' && m.messageUrn),
      'SENT',
    );
    const mine = after.data.filter((m: any) => m.text === 'Reply from member');
    assert.equal(mine.length, 1, 'exactly one copy of the sent message');
    assert.equal(mine[0].sentByName, 'E2E Member');
    const again = await member('POST', `/api/conversations/${janeId}/messages`, { text: 'Reply from member', clientId });
    assert.equal(again.data.id, mine[0].id, 'retry with same clientId is idempotent');
  });

  /** Sends text, waits until the message row matches; returns the rows with that text and the time taken. */
  async function sendAndWait(text: string, done: (row: any) => boolean, timeoutMs = 10_000) {
    const clientId = crypto.randomUUID();
    const t0 = performance.now();
    const sent = await member('POST', `/api/conversations/${janeId}/messages`, { text, clientId });
    const postMs = Math.round(performance.now() - t0);
    assert.equal(sent.status, 200, JSON.stringify(sent.data));
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(10)) {
      const [row] = await sql`SELECT status, error, message_urn FROM messages WHERE client_id = ${clientId}`;
      if (row && done(row)) break;
    }
    const ms = Math.round(performance.now() - t0);
    const rows = await sql`SELECT client_id, status, error, message_urn FROM messages WHERE conversation_id = ${janeId} AND text = ${text}`;
    return { rows, ms, postMs, clientId };
  }

  await step('direct send: SENT within 400 ms of pressing Send, LinkedIn copy merged', async () => {
    const { rows, ms, postMs } = await sendAndWait('[fast] quick reply', (r) => r.status === 'SENT');
    console.log(`    POST /messages answered in ${postMs} ms`);
    console.log(`    app → bridge → SENT in ${ms} ms (plus LinkedIn's own round trip in production)`);
    assert.ok(ms < 400, `took ${ms} ms`);
    await until(
      async () => sql`SELECT message_urn FROM messages WHERE conversation_id = ${janeId} AND text = '[fast] quick reply'`,
      (r) => r.length === 1 && !!r[0].messageUrn,
      'LinkedIn copy merged into the sent message',
    );
    assert.equal(rows.length, 1);
  });

  await step('late LinkedIn copy turns a "could not confirm" failure into SENT (no duplicate)', async () => {
    await sendAndWait('[late] slow confirm', (r) => r.status === 'FAILED');
    const r = await until(
      async () => sql`SELECT status, error, message_urn FROM messages WHERE conversation_id = ${janeId} AND text = '[late] slow confirm'`,
      (x) => x.some((m) => m.status === 'SENT'),
      'SENT after the late copy',
    );
    assert.equal(r.length, 1, 'exactly one copy');
    assert.equal(r[0].error, null);
  });

  await step('LinkedIn copy without a sender is merged into the sent message, not shown as incoming', async () => {
    await sendAndWait('[anon] can i tell you something?', (r) => !!r.message_urn, 3000);
    const r = await sql`
      SELECT m.direction, m.status, m.message_urn, u.name AS sent_by FROM messages m LEFT JOIN users u ON u.id = m.sent_by_user_id
      WHERE m.conversation_id = ${janeId} AND m.text = '[anon] can i tell you something?'`;
    assert.equal(r.length, 1, 'exactly one copy');
    assert.equal(r[0].direction, 'OUTBOUND');
    assert.equal(r[0].sentBy, 'E2E Member');
    assert.ok(r[0].messageUrn);
  });

  await step('an old "?" copy of our own message is repaired when LinkedIn sends the full copy', async () => {
    // Stored before the fix: incoming, no sender, no app message left to merge into.
    const echo = msg('JANE', null, 'what is your name', Date.now());
    await sql`
      INSERT INTO messages (id, conversation_id, account_id, message_urn, direction, text, status, sent_at)
      VALUES (${newId('msg')}, ${janeId}, ${accountId}, ${echo.urn}, 'INBOUND', ${echo.text}, 'SENT', now())`;
    await emit('messages', [echo]);
    const r = await until(
      async () => sql`SELECT direction, sender_urn FROM messages WHERE message_urn = ${echo.urn}`,
      (x) => x[0]?.direction === 'OUTBOUND',
      'repaired as outbound',
    );
    assert.equal(r.length, 1);
    assert.equal(r[0].senderUrn, SELF);
  });

  await step('a failure report never overrides a message LinkedIn already shows', async () => {
    await sendAndWait('[failafter] already there', (r) => !!r.message_urn);
    await sleep(1500); // the failure report arrives 500 ms after the copy
    const r = await sql`SELECT status FROM messages WHERE conversation_id = ${janeId} AND text = '[failafter] already there'`;
    assert.deepEqual(
      r.map((m) => m.status),
      ['SENT'],
    );
  });

  await step('sends that never report back fail after 10 minutes', async () => {
    const { clientId } = await sendAndWait('[silent] browser offline', () => true, 0);
    await sql`UPDATE messages SET created_at = now() - interval '11 minutes' WHERE client_id = ${clientId}`;
    const [m] = await until(
      async () => sql`SELECT status, error FROM messages WHERE client_id = ${clientId}`,
      (r) => r[0]?.status === 'FAILED',
      'FAILED by the worker',
      75_000,
    );
    assert.match(m.error, /did not respond/);
  });

  await step('seen receipt marks the outbound message as seen', async () => {
    const m = (await owner('GET', `/api/conversations/${janeId}/messages`)).data.find((x: any) => x.text === 'Reply from member');
    await emit('seen', [{ messageUrn: m.messageUrn, seenAt: Date.now(), participantUrn: jane.urn }]);
    await until(
      () => owner('GET', `/api/conversations/${janeId}/messages`),
      (r) => !!r.data.find((x: any) => x.id === m.id)?.seenAt,
      'seenAt',
    );
  });

  await step('reply lock blocks a second teammate', async () => {
    assert.equal((await owner('POST', `/api/conversations/${rajId}/lock`, {})).status, 200);
    const blocked = await member('POST', `/api/conversations/${rajId}/messages`, { text: 'x', clientId: crypto.randomUUID() });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /E2E Owner is replying/);
    assert.equal((await owner('DELETE', `/api/conversations/${rajId}/lock`)).status, 200);
  });

  await step('READ access cannot send, assign or open Live LinkedIn', async () => {
    assert.equal((await reader('POST', `/api/conversations/${janeId}/messages`, { text: 'x', clientId: crypto.randomUUID() })).status, 403);
    assert.equal((await reader('PATCH', `/api/conversations/${janeId}`, { isStarred: true })).status, 403);
    assert.equal((await reader('GET', `/api/conversations/${janeId}/messages`)).status, 200);
  });

  await step('through Caddy: app pages with security headers, API, Live View gate', async () => {
    if (CADDY === 'off') return;
    const page = await fetch(`${CADDY}/inbox`);
    assert.equal(page.status, 200, 'app page');
    assert.match(await page.text(), /<div id="root">/);
    assert.equal(page.headers.get('content-security-policy'), "frame-ancestors 'self'");
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(page.headers.get('server'), null, 'Server header hidden');
    assert.equal((await fetch(`${CADDY}/api/health`)).status, 200, 'api');
    const live = (cookie?: string) => fetch(`${CADDY}/live/${accountId}/`, { headers: cookie ? { cookie } : {} }).then((r) => r.status);
    assert.equal(await live(), 401, 'Live View without a session');
    assert.equal(await live('lu_session=forged'), 401, 'Live View with a forged session');
    assert.equal(await live(reader.cookie()), 403, 'Live View with READ access');
  });

  await step('auditor: reads and exports the audit log, nothing else', async () => {
    const email = `auditor-${tag}@e2e.test`;
    const created = await owner('POST', '/api/users', { name: 'E2E Auditor', email, password, role: 'AUDITOR' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const auditor = client();
    assert.equal((await auditor('POST', '/api/auth/login', { email, password })).status, 200);
    assert.equal((await auditor('GET', '/api/audit')).status, 200);
    assert.equal((await auditor('GET', '/api/audit/export?format=json')).status, 200);
    const options = (await auditor('GET', '/api/audit/options')).data;
    assert.ok(
      options.accounts.some((a: any) => a.id === accountId),
      'account names for the filter',
    );
    // No LinkedIn data and no admin powers.
    assert.deepEqual((await auditor('GET', '/api/accounts')).data, []);
    assert.equal((await auditor('GET', `/api/conversations/${janeId}`)).status, 404);
    assert.equal((await auditor('GET', '/api/users/directory')).status, 403);
    assert.equal((await auditor('POST', '/api/users', { name: 'x', email: 'y@e2e.test', password, role: 'ADMIN' })).status, 403);
    assert.ok(
      (await auditor('GET', '/api/users')).data.every((u: any) => u.email === undefined),
      'names only',
    );
    // Can't be given account access, and isn't offered for it.
    const grant = await owner('PUT', `/api/accounts/${accountId}/grants`, [{ userId: created.data.id, level: 'READ' }]);
    assert.equal(grant.status, 400);
    const offered = (await owner('GET', `/api/accounts/${accountId}/grants`)).data;
    assert.ok(!offered.some((g: any) => g.userId === created.data.id));
  });

  await step('members cannot see audit log or manage users', async () => {
    assert.equal((await member('GET', '/api/audit')).status, 403);
    assert.equal((await member('POST', '/api/users', { name: 'x', email: 'x@e2e.test', password: 'xxxxxxxxxxxx' })).status, 403);
  });

  await step('failed sign-ins are recorded with the reason, never the password', async () => {
    const stranger = client();
    const wrong = `not-${password}`;
    assert.equal((await stranger('POST', '/api/auth/login', { email: `member-${tag}@e2e.test`, password: wrong })).status, 401);
    const [e] = await sql`SELECT user_id, meta, actor_name FROM audit_log WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1`;
    assert.equal(e.userId, memberId);
    assert.equal(e.actorName, 'E2E Member');
    assert.equal(e.meta.reason, 'wrong password');
    assert.ok(!JSON.stringify(e.meta).includes(wrong), 'password not stored');
  });

  await step('audit log filters by person, event category and date', async () => {
    const mine = await owner('GET', `/api/audit?userId=${memberId}&action=message`);
    assert.equal(mine.status, 200);
    assert.ok(mine.data.length > 0);
    assert.ok(mine.data.every((e: any) => e.userId === memberId && e.action.startsWith('message.')));
    const future = await owner('GET', `/api/audit?from=${encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString())}`);
    assert.equal(future.data.length, 0);
    const bad = await owner('GET', '/api/audit?from=yesterday');
    assert.equal(bad.status, 400);
  });

  await step('audit export: CSV for Excel, formula-safe, JSON, admins only, and itself recorded', async () => {
    // A name that a spreadsheet would run as a formula must come out as text.
    await sql`UPDATE users SET name = '=HYPERLINK("http://evil")' WHERE id = ${memberId}`;
    await member('POST', `/api/conversations/${janeId}/read`);
    await member('POST', '/api/auth/logout');
    await sql`UPDATE users SET name = 'E2E Member' WHERE id = ${memberId}`;
    await member('POST', '/api/auth/login', { email: `member-${tag}@e2e.test`, password });

    const csv = await owner('GET', `/api/audit/export?format=csv&userId=${memberId}`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.headers.get('content-disposition') ?? '', /attachment; filename="audit-log-\d{8}-\d{4}\.csv"/);
    assert.ok(csv.text.startsWith('Time (UTC),Person,Email,Event'), csv.text.slice(0, 80)); // fetch's text() drops the BOM
    const lines = csv.text.trim().split('\r\n');
    assert.ok(lines.some((l) => l.includes(',Sent a message,message.send,')));
    assert.ok(
      lines.some((l) => l.includes(`"'=HYPERLINK(""http://evil"")"`)),
      'formula escaped',
    );
    assert.ok(!lines.some((l) => /(^|,)"?=HYPERLINK/.test(l)), 'no raw formula');

    const [exported] = await sql`SELECT user_id, meta FROM audit_log WHERE action = 'audit.exported' ORDER BY id DESC LIMIT 1`;
    assert.equal(exported.userId, ownerId);
    assert.equal(exported.meta.rows, lines.length - 1);
    assert.equal(exported.meta.filters.userId, memberId);

    const json = await owner('GET', `/api/audit/export?format=json&action=auth`);
    assert.ok(Array.isArray(json.data) && json.data.length > 0);
    assert.ok(json.data.every((e: any) => e.action.startsWith('auth.') && e.event));
    assert.equal((await member('GET', '/api/audit/export')).status, 403);
  });

  await step('audit entries cannot be edited or deleted', async () => {
    const [e] = await sql`SELECT id FROM audit_log ORDER BY id DESC LIMIT 1`;
    await assert.rejects(sql`UPDATE audit_log SET action = 'auth.login' WHERE id = ${e.id}`, /append-only/);
    await assert.rejects(sql`DELETE FROM audit_log WHERE id = ${e.id}`, /append-only/);
  });

  await step('staff cannot connect LinkedIn accounts (admins assign them)', async () => {
    const r = await member('POST', '/api/accounts', { label: 'Staff tries' });
    assert.equal(r.status, 403);
    assert.equal((await sql`SELECT count(*)::int AS n FROM accounts WHERE label = 'Staff tries'`)[0].n, 0);
  });

  await step('ownership: handed over on the server and in the app, always exactly one owner, recorded', async () => {
    const [previous] = await sql`SELECT id FROM users WHERE role = 'OWNER'`;
    const keeperEmail = `keeper-${tag}@e2e.test`;
    const setOwner = (email: string, pw: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const p = spawn(process.execPath, ['src/cli/set-owner.ts'], { env: { ...process.env, EMAIL: email, NAME: 'Keeper E2E' } });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (out += d));
        p.on('close', (code) => resolve({ code, out }));
        p.stdin.end(pw);
      });
    // New person without a password: refused. With one: created and made owner.
    assert.equal((await setOwner(keeperEmail, '')).code, 1);
    const made = await setOwner(keeperEmail, password);
    assert.equal(made.code, 0, made.out);
    const owners = await sql`SELECT email FROM users WHERE role = 'OWNER'`;
    assert.deepEqual(
      owners.map((o) => o.email),
      [keeperEmail],
    );
    if (previous)
      assert.equal((await sql`SELECT role FROM users WHERE id = ${previous.id}`)[0].role, 'ADMIN', 'previous owner is an admin');

    // In the app: only the owner can hand it over; the new owner can then hand it back.
    const keeper = client();
    assert.equal((await keeper('POST', '/api/auth/login', { email: keeperEmail, password })).status, 200);
    const back = previous?.id ?? ownerId;
    assert.equal((await owner('POST', `/api/users/${back}/owner`)).status, 403, 'an admin cannot');
    assert.equal((await keeper('POST', `/api/users/${back}/owner`)).status, 200);
    const after =
      await sql`SELECT id, role FROM users WHERE id IN ${sql([back, (await sql`SELECT id FROM users WHERE email = ${keeperEmail}`)[0].id])}`;
    assert.deepEqual(after.find((u) => u.id === back)?.role, 'OWNER');
    assert.deepEqual(after.find((u) => u.id !== back)?.role, 'ADMIN');
    await assert.rejects(sql`UPDATE users SET role = 'OWNER' WHERE email = ${keeperEmail}`, /users_single_owner/);
    const logged =
      await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.owner_transferred' AND created_at > now() - interval '1 minute'`;
    assert.ok(logged[0].n >= 2, 'both handovers recorded');
    // Leave things as they were.
    if (!previous) await sql`UPDATE users SET role = 'ADMIN' WHERE id = ${ownerId}`;
  });

  await step('assign staff: per person and many at once, admins only, staff only, only real changes recorded', async () => {
    const access = await owner('GET', `/api/users/${memberId}/access`);
    assert.equal(access.status, 200);
    assert.equal(access.data.find((a: any) => a.accountId === accountId)?.level, 'REPLY');
    assert.equal((await member('GET', `/api/users/${memberId}/access`)).status, 403, 'admins only');
    assert.equal((await owner('GET', `/api/users/${ownerId}/access`)).status, 400, 'admins see everything already');

    const logs = async () =>
      (await sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'account.grants_changed' AND account_id = ${accountId}`)[0].n;
    const before = await logs();
    assert.equal((await owner('PUT', `/api/users/${memberId}/access`, [{ accountId, level: 'READ' }])).data.changed, 1);
    const memberLevel = async () => ((await member('GET', '/api/accounts')).data as any[]).find((a) => a.id === accountId)?.level;
    assert.equal(await memberLevel(), 'READ', 'READ now (they see it at once)');
    assert.equal((await owner('PUT', `/api/users/${memberId}/access`, [{ accountId, level: 'READ' }])).data.changed, 0, 'no-op');
    assert.equal(await logs(), before + 1, 'one entry, only for the real change');

    // Two new staff members and the member at once; then the two lose access again.
    const ids: string[] = [];
    for (const n of ['one', 'two']) {
      const r = await owner('POST', '/api/users', { name: `Bulk ${n}`, email: `bulk-${n}-${tag}@e2e.test`, password, role: 'MEMBER' });
      ids.push(r.data.id);
    }
    const bulk = await owner('POST', '/api/users/access/bulk', { userIds: [...ids, memberId], accountIds: [accountId], level: 'REPLY' });
    assert.equal(bulk.data.changed, 3);
    assert.equal((await owner('GET', '/api/users')).data.find((u: any) => u.id === ids[0]).accountCount, 1);
    assert.equal(
      (await owner('POST', '/api/users/access/bulk', { userIds: [ownerId], accountIds: [accountId], level: 'READ' })).status,
      400,
    );
    assert.equal((await member('POST', '/api/users/access/bulk', { userIds: ids, accountIds: [accountId], level: 'FULL' })).status, 403);
    assert.equal((await owner('POST', '/api/users/access/bulk', { userIds: ids, accountIds: [accountId], level: null })).data.changed, 2);
    assert.equal((await sql`SELECT count(*)::int AS n FROM account_grants WHERE user_id IN ${sql(ids)}`)[0].n, 0);
    assert.equal(await memberLevel(), 'REPLY', 'REPLY again');
  });

  await step('new users get exactly DEFAULT_GRANT (nothing when NONE)', async () => {
    const created = await owner('POST', '/api/users', { name: 'Newbie', email: `newbie-${tag}@e2e.test`, password, role: 'MEMBER' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const grants = await sql`SELECT level FROM account_grants WHERE user_id = ${created.data.id} AND account_id = ${accountId}`;
    if (config.defaultGrant === 'NONE') assert.equal(grants.length, 0, 'no access until an admin grants it');
    else
      assert.deepEqual(
        grants.map((g) => g.level),
        [config.defaultGrant],
      );
    const newbie = client();
    await newbie('POST', '/api/auth/login', { email: `newbie-${tag}@e2e.test`, password });
    const seen = await newbie('GET', '/api/accounts');
    assert.equal(
      seen.data.some((a: any) => a.id === accountId),
      config.defaultGrant !== 'NONE',
    );
    assert.equal((await newbie('GET', `/api/conversations/${janeId}`)).status, config.defaultGrant === 'NONE' ? 404 : 200);
  });

  await step('opening an unread conversation marks it read (also on LinkedIn)', async () => {
    await owner('POST', `/api/conversations/${janeId}/read`);
    const c = await owner('GET', `/api/conversations/${janeId}`);
    assert.equal(c.data.unreadCount, 0);
    await until(async () => commands.some((x) => x.type === 'mark_read'), Boolean, 'mark_read command');
  });

  await step('new inbound realtime message bumps unread + preview', async () => {
    await emit('messages', [msg('JANE', jane, 'Realtime ping', Date.now())]);
    await until(
      () => owner('GET', `/api/conversations/${janeId}`),
      (r) => r.data.unreadCount === 1 && r.data.lastMessagePreview === 'Realtime ping',
      'realtime bump',
    );
  });

  await step('daily send cap is enforced', async () => {
    await sql`UPDATE accounts SET daily_send_cap = 1 WHERE id = ${accountId}`;
    const r = await owner('POST', `/api/conversations/${rajId}/messages`, { text: 'over cap', clientId: crypto.randomUUID() });
    assert.equal(r.status, 429);
  });

  await step('paused account refuses to send', async () => {
    await sql`UPDATE accounts SET daily_send_cap = 80, send_paused = true WHERE id = ${accountId}`;
    const r = await owner('POST', `/api/conversations/${rajId}/messages`, { text: 'paused', clientId: crypto.randomUUID() });
    assert.equal(r.status, 409);
  });

  await step('connections sync + search', async () => {
    await emit('contacts', {
      connections: true,
      items: [
        {
          urn: jane.urn,
          publicId: `jane-${tag}`,
          name: 'Jane E2E',
          headline: 'CTO at Acme',
          avatarUrl: null,
          profileUrl: 'https://www.linkedin.com/in/jane/',
        },
      ],
    });
    const r = await until(
      () => member('GET', `/api/accounts/${accountId}/connections?q=acme`),
      (x) => x.data?.items?.length === 1,
      'connection',
    );
    assert.equal(r.data.items[0]?.name, 'Jane E2E', JSON.stringify(r.data));
    janeContactId = r.data.items[0].id;
  });

  await step('Message on a connection opens the existing chat with them; a stranger gets a new chat', async () => {
    const jane = await member('GET', `/api/accounts/${accountId}/connections/${janeContactId}`);
    assert.equal(jane.status, 200);
    assert.equal(jane.data.conversationId, janeId, 'the chat with Jane (matched by her LinkedIn id)');
    assert.equal(jane.data.contact.name, 'Jane E2E');
    assert.equal(jane.data.contact.memberUrn, undefined, 'internal ids stay internal');
    await emit('contacts', {
      connections: true,
      items: [
        { urn: `public:new-${tag}`, publicId: `new-${tag}`, name: `Nobody Yet ${tag}`, headline: null, avatarUrl: null, profileUrl: null },
      ],
    });
    const fresh = await until(
      () => member('GET', `/api/accounts/${accountId}/connections?q=${encodeURIComponent(`Nobody Yet ${tag}`)}`),
      (x) => x.data?.items?.length === 1,
      'new connection',
    );
    const stranger = await member('GET', `/api/accounts/${accountId}/connections/${fresh.data.items[0].id}`);
    assert.equal(stranger.data.conversationId, null);
    const other = client();
    assert.equal((await other('GET', `/api/accounts/${accountId}/connections/${janeContactId}`)).status, 401);
  });

  await step('new chats from Network obey pause and the daily cap', async () => {
    const start = () => member('POST', `/api/accounts/${accountId}/connections/${janeContactId}/message`, { text: 'Hello from Network' });
    assert.equal((await start()).status, 409, 'paused (from the previous step)');
    await sql`UPDATE accounts SET send_paused = false, daily_send_cap = 1 WHERE id = ${accountId}`;
    assert.equal((await start()).status, 429, 'cap reached');
    await sql`UPDATE accounts SET daily_send_cap = 80 WHERE id = ${accountId}`;
    assert.equal((await start()).status, 200);
  });

  let labelId = '';
  const csvFile = (name: string, lines: string[]) => {
    const fd = new FormData();
    fd.append('file', new Blob([lines.join('\r\n')], { type: 'text/csv' }), name);
    return fd;
  };
  const importDone = () =>
    until(
      async () => (await owner('GET', `/api/accounts/${accountId}/import`)).data,
      (s) => s.state === 'done' || s.state === 'failed',
      'import finished',
    );

  await step('archive import: Connections.csv merges with synced connections (live names win)', async () => {
    const upload = await owner(
      'POST',
      `/api/accounts/${accountId}/import`,
      csvFile('Connections.csv', [
        'Notes:',
        '"When exporting your connection data, you may notice that some of the email addresses are missing."',
        '',
        'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
        `Jane,Archived-Name,https://www.linkedin.com/in/jane-${tag},,Acme,CTO,01 Mar 2024`,
        `Omar,Archive,https://www.linkedin.com/in/omar-${tag},,"Big, Corp",Engineer,15 Jun 2023`,
        'Broken,Row,,,,,',
      ]),
    );
    assert.equal(upload.status, 200, JSON.stringify(upload.data));
    const s = await importDone();
    assert.equal(s.state, 'done', s.error);
    assert.equal(s.kind, 'connections');
    assert.equal(s.added, 1, 'Omar is new; Jane already synced');
    assert.equal(s.skipped, 1, 'the row without a profile URL');
    const [jane] = await sql`SELECT name, connected_at FROM contacts WHERE account_id = ${accountId} AND public_id = ${`jane-${tag}`}`;
    assert.equal(jane.name, 'Jane E2E', 'live name kept');
    assert.equal(new Date(jane.connectedAt).getUTCFullYear(), 2024);
    const [omar] = await sql`SELECT headline FROM contacts WHERE account_id = ${accountId} AND public_id = ${`omar-${tag}`}`;
    assert.equal(omar.headline, 'Engineer at Big, Corp');
    // A file of another kind is refused with what it does contain.
    await owner('POST', `/api/accounts/${accountId}/import`, csvFile('other.csv', ['Name,Phone', 'x,1']));
    const bad = await importDone();
    assert.equal(bad.state, 'failed');
    assert.match(bad.error, /found columns: Name, Phone/);
    assert.equal((await member('GET', `/api/accounts/${accountId}/import`)).status, 403, 'FULL access needed');
  });

  await step('archive import: messages.csv adds older history once, skips what the live sync has', async () => {
    const at = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    const lines = [
      'CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER',
      // Already synced live (same text, same minute): skipped.
      `2-JANE${tag},,Jane E2E,https://www.linkedin.com/in/jane-${tag},E2E Self,https://www.linkedin.com/in/e2e,${at(now - 600_000)},,Old hello from Jane,INBOX`,
      // Older than anything synced: added to Jane's chat.
      `2-JANE${tag},,E2E Self,https://www.linkedin.com/in/e2e,Jane E2E,https://www.linkedin.com/in/jane-${tag},${at(now - 30 * 86_400_000)},,"First ever message, with ""quotes""\nand two lines",INBOX`,
      // A chat the live sync never saw: created.
      `2-OLD${tag},,Lena Old,https://www.linkedin.com/in/lena-${tag},E2E Self,https://www.linkedin.com/in/e2e,${at(now - 90 * 86_400_000)},,<p>Hi from <b>2025</b> &amp; more</p>,ARCHIVE`,
    ];
    await owner('POST', `/api/accounts/${accountId}/import`, csvFile('messages.csv', lines));
    const s = await importDone();
    assert.equal(s.state, 'done', s.error);
    assert.equal(s.kind, 'messages');
    assert.equal(s.added, 2);
    assert.equal(s.skipped, 1);
    const jane = await owner('GET', `/api/conversations/${janeId}/messages?limit=200`);
    const first = jane.data[0];
    assert.equal(first.text, 'First ever message, with "quotes"\nand two lines');
    assert.equal(first.direction, 'OUTBOUND');
    const [old] =
      await sql`SELECT id, folder, participants FROM conversations WHERE account_id = ${accountId} AND thread_id = ${`2-OLD${tag}`}`;
    assert.equal(old.folder, 'archived');
    assert.equal(old.participants[0].name, 'Lena Old');
    const [msg] = await sql`SELECT text, direction FROM messages WHERE conversation_id = ${old.id}`;
    assert.equal(msg.text, 'Hi from 2025 & more', 'HTML reduced to text');
    assert.equal(msg.direction, 'INBOUND');
    // The same file again adds nothing.
    await owner('POST', `/api/accounts/${accountId}/import`, csvFile('messages.csv', lines));
    assert.equal((await importDone()).added, 0);
  });

  await step('paging never skips messages that share a timestamp at a page edge', async () => {
    const same = new Date(now - 7 * 86_400_000);
    for (const n of [1, 2, 3]) {
      await sql`
        INSERT INTO messages (id, conversation_id, account_id, message_urn, direction, text, status, sent_at)
        VALUES (${newId('msg')}, ${rajId}, ${accountId}, ${`urn:e2e:tie:${tag}:${n}`}, 'INBOUND', ${`tie ${n}`}, 'SENT', ${same})`;
    }
    const seen: string[] = [];
    let page = (
      await owner(
        'GET',
        `/api/conversations/${rajId}/messages?limit=2&before=${encodeURIComponent(new Date(now - 6 * 86_400_000).toISOString())}`,
      )
    ).data;
    while (page.length) {
      seen.push(...page.map((m: any) => m.text));
      const first = page[0];
      page = (
        await owner('GET', `/api/conversations/${rajId}/messages?limit=2&before=${encodeURIComponent(first.sentAt)}&beforeId=${first.id}`)
      ).data;
    }
    assert.deepEqual(seen.filter((t) => t.startsWith('tie ')).sort(), ['tie 1', 'tie 2', 'tie 3']);
  });

  await step('chat export: latest N chats with their messages, admins only, recorded', async () => {
    const json = await owner('GET', `/api/conversations/export?accountId=${accountId}&limit=1&format=json`);
    assert.equal(json.status, 200);
    const chats = new Set(json.data.map((r: any) => r.conversationId));
    assert.equal(chats.size, 1, 'only the latest chat');
    assert.ok(json.data.every((r: any) => r.account === 'E2E account' && r.time && ['Sent', 'Received'].includes(r.direction)));
    const csv = await owner('GET', `/api/conversations/export?accountId=${accountId}&limit=5&format=csv`);
    assert.ok(csv.text.startsWith('Conversation,Conversation ID,LinkedIn account,Time (UTC)'), csv.text.slice(0, 80));
    assert.ok(csv.text.includes('"First ever message, with ""quotes""\nand two lines"'), 'multi-line text quoted');
    assert.equal((await member('GET', '/api/conversations/export')).status, 403);
    const [audited] = await sql`SELECT meta FROM audit_log WHERE action = 'conversations.exported' ORDER BY id DESC LIMIT 1`;
    assert.equal(audited.meta.format, 'csv');
    assert.ok(audited.meta.rows > 0);
  });

  await step('safe volume: new-chat cap, ramp-up for new accounts, automatic pause on a LinkedIn warning', async () => {
    // New chats have their own, lower cap.
    await sql`UPDATE accounts SET send_paused = false, daily_send_cap = 80, new_chat_cap = 0 WHERE id = ${accountId}`;
    const capped = await owner('POST', `/api/accounts/${accountId}/connections/${janeContactId}/message`, { text: 'hi' });
    assert.equal(capped.status, 429);
    assert.match(capped.data.error, /new chats/);
    await sql`UPDATE accounts SET new_chat_cap = 20 WHERE id = ${accountId}`;

    // A newly connected account ramps up: 20 today, +10 per day, up to its cap.
    await sql`UPDATE accounts SET ramp_started_at = now() - interval '2 days 1 hour' WHERE id = ${accountId}`;
    const ramping = (await owner('GET', `/api/accounts/${accountId}`)).data;
    assert.equal(ramping.effectiveSendCap, 40);
    assert.equal(ramping.rampDaysLeft, 4);
    assert.equal((await owner('PATCH', `/api/accounts/${accountId}`, { skipRamp: true })).status, 200);
    assert.equal((await owner('GET', `/api/accounts/${accountId}`)).data.effectiveSendCap, 80);

    // LinkedIn shows a limit warning while sending: the account pauses itself and its ramp restarts.
    const r = await member('POST', `/api/conversations/${janeId}/messages`, { text: '[limited] hello', clientId: crypto.randomUUID() });
    assert.equal(r.status, 200);
    const paused = await until(
      async () => (await owner('GET', `/api/accounts/${accountId}`)).data,
      (a) => a.sendPaused,
      'paused automatically',
    );
    assert.match(paused.pausedReason, /limit/);
    assert.equal(paused.effectiveSendCap, 20, 'ramp restarted');
    assert.equal((await sql`SELECT 1 FROM audit_log WHERE account_id = ${accountId} AND action = 'account.auto_paused'`).length, 1);
    const blocked = await member('POST', `/api/conversations/${janeId}/messages`, { text: 'more', clientId: crypto.randomUUID() });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /paused: LinkedIn/);
    // An admin resumes after checking: the reason is cleared.
    await owner('PATCH', `/api/accounts/${accountId}`, { sendPaused: false, skipRamp: true });
    const resumed = (await owner('GET', `/api/accounts/${accountId}`)).data;
    assert.equal(resumed.sendPaused, false);
    assert.equal(resumed.pausedReason, null);
  });

  await step('labels: create, tag a conversation, filter by label', async () => {
    const l = await member('POST', '/api/labels', { name: `e2e-${tag}-hot`, color: '#ff0000' });
    assert.equal(l.status, 200, JSON.stringify(l.data));
    labelId = l.data.id;
    const tagged = await member('PUT', `/api/conversations/${rajId}/labels`, { labelIds: [labelId] });
    assert.deepEqual(
      tagged.data.labels.map((x: any) => x.id),
      [labelId],
    );
    const filtered = await member('GET', `/api/conversations?accountId=${accountId}&view=other&labelId=${labelId}`);
    assert.equal(filtered.data.length, 1);
    assert.equal((await reader('PUT', `/api/conversations/${rajId}/labels`, { labelIds: [] })).status, 403, 'READ cannot change labels');
    assert.equal((await member('DELETE', `/api/labels/${labelId}`)).status, 403, 'only admins delete labels');
  });

  await step('awaiting-reply view lists conversations whose last message is from them', async () => {
    const r = await owner('GET', `/api/conversations?accountId=${accountId}&view=awaiting`);
    assert.ok(
      r.data.some((c: any) => c.id === janeId),
      'Jane wrote last (realtime ping)',
    );
  });

  await step('outreach views: Replied (they wrote back) and No reply yet (only our messages)', async () => {
    const solo = person(`urn:li:fsd_profile:SOLO${tag}`, 'Solo E2E');
    await emit('conversations', [
      {
        urn: conv('SOLO'),
        threadId: `2-SOLO${tag}`,
        title: null,
        isGroup: false,
        unreadCount: 0,
        lastActivityAt: Date.now(),
        folder: 'focused',
        participants: [solo],
      },
    ]);
    await emit('messages', [msg('SOLO', null, 'Hi Solo, outreach', Date.now())]);
    const view = async (v: string) =>
      ((await owner('GET', `/api/conversations?accountId=${accountId}&view=${v}`)).data as any[]).map((c) => c.id);
    const noReply = await until(
      () => view('no_reply'),
      (ids) => ids.length > 0,
      'no reply yet',
    );
    const [{ id: soloId }] = await sql`SELECT id FROM conversations WHERE thread_urn = ${conv('SOLO')}`;
    assert.ok(noReply.includes(soloId), 'we wrote, they never answered');
    assert.ok(!noReply.includes(janeId), 'Jane answered');
    const replied = await view('replied');
    assert.ok(replied.includes(janeId));
    assert.ok(!replied.includes(soloId));
    // The prospect answers: it moves from No reply yet to Replied.
    await emit('messages', [msg('SOLO', solo, 'Thanks, interested', Date.now() + 1000)]);
    await until(
      () => view('replied'),
      (ids) => ids.includes(soloId),
      'moved to Replied',
    );
    assert.ok(!(await view('no_reply')).includes(soloId));
  });

  await step('snooze hides a conversation until a reply arrives', async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    assert.equal((await owner('PATCH', `/api/conversations/${janeId}`, { snoozedUntil: until })).status, 200);
    const all = await owner('GET', `/api/conversations?accountId=${accountId}&view=all`);
    assert.ok(!all.data.some((c: any) => c.id === janeId), 'snoozed is hidden from All');
    const snoozed = await owner('GET', `/api/conversations?accountId=${accountId}&view=snoozed`);
    assert.ok(snoozed.data.some((c: any) => c.id === janeId));
    await emit('messages', [msg('JANE', jane, 'Wake up ping', Date.now())]);
    await until_(
      () => owner('GET', `/api/conversations/${janeId}`),
      (r) => r.data.snoozedUntil === null,
      'unsnoozed by reply',
    );
  });

  await step('saved replies: shared vs private', async () => {
    const shared = await owner('POST', '/api/templates', { title: 'Intro', body: 'Hi {firstName}!', shared: true });
    const priv = await owner('POST', '/api/templates', { title: 'Mine', body: 'secret', shared: false });
    const seen = await member('GET', '/api/templates');
    assert.ok(seen.data.some((t: any) => t.id === shared.data.id));
    assert.ok(!seen.data.some((t: any) => t.id === priv.data.id), 'private template hidden from others');
    assert.equal((await member('DELETE', `/api/templates/${shared.data.id}`)).status, 403);
    await owner('DELETE', `/api/templates/${shared.data.id}`);
    await owner('DELETE', `/api/templates/${priv.data.id}`);
  });

  await step('webhooks: signed delivery for new messages + test ping', async () => {
    const created = await owner('POST', '/api/webhooks', { url: WEBHOOK_URL, events: ['message.received'] });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const secret = created.data.secret as string;
    assert.ok(secret, 'secret returned once');
    assert.equal((await member('GET', '/api/webhooks')).status, 403);
    const ping = await owner('POST', `/api/webhooks/${created.data.id}/test`);
    assert.equal(ping.data.ok, true, JSON.stringify(ping.data));
    await emit('messages', [msg('RAJ', raj, 'Webhook me', Date.now())]);
    const hit = await until_(async () => received.find((r) => r.event === 'message.received'), Boolean, 'webhook delivery', 15_000);
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(hit!.body).digest('hex')}`;
    assert.equal(hit!.signature, expected, 'valid HMAC signature');
    assert.equal(hit!.legacySignature, expected, 'also under the former header name (receivers set up before the rename)');
    assert.equal(JSON.parse(hit!.body).data.message.text, 'Webhook me');
  });

  await step('staff activity: per teammate (messages only), drill-down, export; admins and auditors only', async () => {
    const r = await owner('GET', `/api/activity/staff?accountId=${accountId}`);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const m = r.data.staff.find((x: any) => x.id === memberId);
    assert.ok(m && m.sent >= 1, JSON.stringify(r.data.staff));
    assert.ok(m.conversations >= 1);
    assert.ok(m.lastActiveAt);
    assert.equal((await member('GET', '/api/activity/staff')).status, 403, 'staff cannot see it');
    assert.equal((await reader('GET', '/api/activity/staff')).status, 403);

    const sent = await owner('GET', `/api/activity/staff/${memberId}/messages?accountId=${accountId}`);
    assert.ok(sent.data.length >= 1);
    assert.ok(sent.data.every((x: any) => x.accountLabel === 'E2E account' && x.prospect));
    // Only what this teammate sent from the app: nothing the prospect wrote, nothing a colleague sent.
    const ids = sent.data.map((x: any) => x.id);
    const others =
      await sql`SELECT count(*)::int AS n FROM messages WHERE id IN ${sql(ids)} AND (direction <> 'OUTBOUND' OR sent_by_user_id <> ${memberId})`;
    assert.equal(others[0].n, 0);

    const csv = await owner('GET', `/api/activity/export?userId=${memberId}`);
    assert.equal(csv.status, 200);
    assert.ok(
      csv.text.startsWith('Time (UTC),Staff,Staff email,LinkedIn account,Prospect,Status,Message,Error,Conversation'),
      csv.text.slice(0, 80),
    ); // fetch's text() drops the BOM
    assert.ok(csv.text.includes('E2E Member'));
    assert.equal((await member('GET', '/api/activity/export')).status, 403);
    const [log] =
      await sql`SELECT meta FROM audit_log WHERE action = 'activity.exported' AND user_id = ${ownerId} ORDER BY id DESC LIMIT 1`;
    assert.equal(log?.meta.staffUserId, memberId);
  });

  if (config.crmSync && config.twenty?.url === 'http://api:4100/graphql') {
    await step('Twenty CRM: prospects become people (by LinkedIn link, by name, or new), messages become notes on them', async () => {
      const personOf = async (id: string) =>
        (await sql`SELECT twenty_person_id FROM conversations WHERE id = ${id}`)[0].twentyPersonId as string | null;
      const janeTwentyId = await until(() => personOf(janeId), Boolean, 'Jane linked in Twenty', 60_000);
      const janeInTwenty = twentyPeople.find((x) => x.id === janeTwentyId);
      assert.equal(janeInTwenty?.firstName, 'Jane');
      assert.equal(
        await until(() => personOf(rajId), Boolean, 'Raj linked in Twenty', 60_000),
        rajInTwenty,
        'existing person found by name',
      );
      const notes = await until(
        async () => twentyNotes.filter((n) => n.personId === janeTwentyId),
        (l) => l.some((n) => n.title.includes('replied')) && l.some((n) => n.title.includes('message to')),
        'notes on Jane',
        60_000,
      );
      const sentNote = notes.find((n) => n.title.includes('message to'));
      assert.match(sentNote?.markdown ?? '', /Sent by .+ · LinkedIn account E2E account/);
      assert.ok(
        notes.every((n) => n.personId),
        'no note left without a person',
      );
      const [state] = await sql`SELECT count(*)::int AS n FROM messages WHERE conversation_id = ${janeId} AND crm_note_id IS NOT NULL`;
      assert.ok(state.n >= 2);

      // A connection we know (profile link from the connections list) and one already in Twenty by that link.
      const chatWith = async (who: string, prospect: typeof jane, profileUrl: string) => {
        await emit('contacts', {
          connections: true,
          items: [
            {
              urn: prospect.urn,
              publicId: `${who.toLowerCase()}-${tag}`,
              name: prospect.name,
              headline: 'Buyer',
              avatarUrl: null,
              profileUrl,
            },
          ],
        });
        await until(
          async () => (await sql`SELECT 1 FROM contacts WHERE member_urn = ${prospect.urn}`).length,
          Boolean,
          `${who} connection`,
        );
        await emit('conversations', [
          {
            urn: conv(who),
            threadId: `2-${who}${tag}`,
            title: null,
            isGroup: false,
            unreadCount: 1,
            lastActivityAt: Date.now(),
            folder: 'focused',
            participants: [prospect],
          },
        ]);
        await emit('messages', [msg(who, prospect, `Hello from ${prospect.name}`, Date.now())]);
        const [c] = await until(
          () => sql`SELECT id FROM conversations WHERE thread_urn = ${conv(who)}`,
          (r) => r.length > 0,
          `${who} chat`,
        );
        return until(() => personOf(c.id), Boolean, `${who} in Twenty`, 60_000);
      };
      const lina = person(`urn:li:fsd_profile:LINA${tag}`, 'Lina E2E');
      const linaUrl = `https://www.linkedin.com/in/lina-${tag}/`;
      const linaId = await chatWith('LINA', lina, linaUrl);
      assert.equal(twentyPeople.find((x) => x.id === linaId)?.linkedin, linaUrl, 'created with the LinkedIn profile link');
      assert.equal(twentyPeople.find((x) => x.id === linaId)?.jobTitle, 'Buyer');
      const omarInTwenty = crypto.randomUUID();
      const omarUrl = `https://www.linkedin.com/in/omar-${tag}`;
      twentyPeople.push({ id: omarInTwenty, firstName: 'Someone', lastName: 'Else', linkedin: `${omarUrl}?trk=x` });
      const omar = person(`urn:li:fsd_profile:OMAR${tag}`, 'Omar E2E');
      assert.equal(await chatWith('OMAR', omar, `${omarUrl}/`), omarInTwenty, 'found by LinkedIn link, whatever the name in Twenty');

      const status = await owner('GET', '/api/crm/status');
      assert.equal(status.data.enabled, true);
      assert.ok(status.data.people >= 2);
      assert.equal((await member('GET', '/api/crm/status')).status, 403);
    });
  } else {
    console.log('  (Twenty CRM sync tests skipped: they need CRM_SYNC=on and TWENTY_API_URL=http://api:4100/graphql)');
  }

  await step('config + push subscription endpoints', async () => {
    const cfg = await member('GET', '/api/config');
    assert.ok(cfg.data.vapidPublicKey, 'VAPID key generated');
    assert.equal(cfg.data.features.aiDrafts, false);
    const sub = { endpoint: `https://push.example.invalid/${tag}`, keys: { p256dh: 'x', auth: 'y' } };
    assert.equal((await member('POST', '/api/push/subscriptions', sub)).status, 200);
    assert.equal((await member('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint })).status, 200);
    assert.equal((await member('POST', `/api/conversations/${janeId}/draft`, {})).status, 404, 'AI drafts off by default');
  });

  await step(
    'reconnect: the most recent chats reload (not all 100), chats with activity while away fetch their history again',
    async () => {
      const self = { urn: SELF, name: 'E2E Self', headline: 'Tester', publicId: 'e2e', avatarUrl: null };
      await emit('session', { status: 'NEEDS_ATTENTION', self: null });
      await until(
        () => owner('GET', `/api/accounts/${accountId}`),
        (r) => r.data?.status === 'NEEDS_ATTENTION',
        'away',
      );
      await sql`UPDATE conversations SET history_synced_at = now(), history_requested_at = now() WHERE account_id = ${accountId}`;
      const [{ newest }] = await sql`SELECT max(last_message_at) AS newest FROM conversations WHERE account_id = ${accountId}`;
      const before = commands.length;
      await emit('session', { status: 'CONNECTED', self });
      await until(
        async () => commands.slice(before).find((c) => c.type === 'sync_inbox' && !c.target && c.scrolls <= 3),
        Boolean,
        'light catch-up of the recent chats only',
      );
      assert.ok(!commands.slice(before).some((c) => c.type === 'sync_connections'), 'not the whole first sync again');

      const stub = (who: string, person: typeof jane, at: number) => ({
        urn: conv(who),
        threadId: `2-${who}${tag}`,
        title: null,
        isGroup: false,
        unreadCount: 0,
        lastActivityAt: at,
        folder: 'focused',
        participants: [person],
      });
      // Jane wrote while the account was away; Raj's chat didn't change.
      const list = [stub('JANE', jane, newest.getTime() + 60_000), stub('RAJ', raj, newest.getTime() - 3_600_000)];
      await emit('conversations', list);
      const fetched = await until(
        async () => commands.slice(before).filter((c) => c.type === 'sync_thread'),
        (l) => l.length > 0,
        'history of the changed chat',
      );
      await emit(
        'conversations',
        list.map((c) => ({ ...c, unreadCount: 1 })),
      ); // the same list again
      await sleep(1500);
      const all = commands.slice(before).filter((c) => c.type === 'sync_thread');
      assert.deepEqual(
        all.map((c) => c.conversationUrn),
        [conv('JANE')],
        'only the chat that changed, once',
      );
      assert.equal(fetched[0].conversationUrn, conv('JANE'));
    },
  );

  await step('full sync again: chats, history and connections, full access only, one at a time, recorded', async () => {
    assert.equal((await member('POST', `/api/accounts/${accountId}/resync`)).status, 403);
    const before = commands.length;
    assert.equal((await owner('POST', `/api/accounts/${accountId}/resync`)).status, 200);
    const sync = (await owner('GET', `/api/accounts/${accountId}`)).data.sync;
    assert.equal(sync.finishedAt, null);
    assert.equal(sync.conversations.loaded, 0);
    const [h] =
      await sql`SELECT count(*) FILTER (WHERE history_synced_at IS NOT NULL)::int AS n FROM conversations WHERE account_id = ${accountId}`;
    assert.equal(h.n, 0, 'every history counts as not loaded');
    await until(
      async () => commands.slice(before),
      (l) => l.some((c) => c.type === 'sync_inbox' && c.target === 100) && l.some((c) => c.type === 'sync_connections'),
      'first sync commands',
    );
    assert.equal((await owner('POST', `/api/accounts/${accountId}/resync`)).status, 409, 'already running');
    const [log] = await sql`SELECT user_id FROM audit_log WHERE account_id = ${accountId} AND action = 'account.resynced'`;
    assert.equal(log?.userId, ownerId);
  });

  await step('NEEDS_ATTENTION status reaches the account', async () => {
    await emit('session', { status: 'NEEDS_ATTENTION', self: null });
    await until(
      () => owner('GET', `/api/accounts/${accountId}`),
      (r) => r.data?.status === 'NEEDS_ATTENTION',
      'NEEDS_ATTENTION',
    );
    const r = await owner('POST', `/api/conversations/${rajId}/messages`, { text: 'x', clientId: crypto.randomUUID() });
    assert.equal(r.status, 409, 'cannot send while account needs attention');
  });
  await step('a conversation payload without folder/unread/group keeps the stored values', async () => {
    const [before] = await sql`SELECT folder, unread_count, is_group FROM conversations WHERE id = ${rajId}`;
    // As a message's conversation stub or a partial realtime update would arrive: only the URN and a time.
    await emit('conversations', [
      {
        urn: conv('RAJ'),
        threadId: `2-RAJ${tag}`,
        title: null,
        isGroup: null,
        unreadCount: null,
        folder: null,
        lastActivityAt: null,
        participants: [],
      },
    ]);
    await sleep(1000);
    const [after] = await sql`SELECT folder, unread_count, is_group, participants FROM conversations WHERE id = ${rajId}`;
    assert.equal(after.folder, before.folder);
    assert.equal(after.unreadCount, before.unreadCount);
    assert.equal(after.isGroup, before.isGroup);
    assert.equal(after.participants[0]?.name, 'Raj E2E', 'participants kept too');
  });

  await step('audit category filters follow the event catalog (labels are under Settings, with IP)', async () => {
    const r = await owner('GET', '/api/audit?action=settings');
    const label = r.data.find((e: any) => e.action === 'label.created' && e.meta.name === `e2e-${tag}-hot`);
    assert.ok(label, 'label.created listed under the Settings category');
    assert.ok(label.ip, 'IP recorded');
    assert.ok(r.data.every((e: any) => /^(label|webhook)\./.test(e.action)));
  });

  // ---------- company sign-in + Twilio staff sync (only against the test's own fake staff list) ----------
  if (config.microsoft && config.staffSync.url === 'http://api:4100') {
    const ms = config.microsoft;
    const syncNow = async () => {
      const r = await owner('POST', '/api/users/directory/sync');
      assert.equal(r.status, 200, JSON.stringify(r.data));
      return r.data;
    };
    const userByEmail = async (email: string) =>
      (
        await sql`SELECT id, role, source, staff_id, password_hash, disabled_at, disabled_by, disabled_reason FROM users WHERE email = ${email}`
      )[0];

    await step('Microsoft sign-in: PKCE redirect to the company tenant, bound to the browser', async () => {
      assert.deepEqual((await owner('GET', '/api/auth/methods')).data, { microsoft: true, password: 'on' });
      const start = await fetch(`${API}/api/auth/microsoft`, { redirect: 'manual' });
      assert.equal(start.status, 302);
      const to = new URL(start.headers.get('location') ?? '');
      assert.equal(`${to.origin}${to.pathname}`, `https://login.microsoftonline.com/${ms.tenantId}/oauth2/v2.0/authorize`);
      assert.equal(to.searchParams.get('client_id'), ms.clientId);
      assert.equal(to.searchParams.get('redirect_uri'), `${config.appUrl}/api/auth/microsoft/callback`);
      assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(to.searchParams.get('code_challenge')?.length, 43);
      assert.match(to.searchParams.get('scope') ?? '', /openid/);
      const state = to.searchParams.get('state');
      const cookie = start.headers.get('set-cookie') ?? '';
      assert.match(cookie, new RegExp(`^lu_oidc=${state};.*HttpOnly`, 'i'));
      // Finishing someone else's sign-in (no or different browser cookie) is refused.
      for (const headers of [{}, { cookie: 'lu_oidc=someone-else' }]) {
        const cb = await fetch(`${API}/api/auth/microsoft/callback?code=x&state=${state}`, { redirect: 'manual', headers });
        assert.equal(cb.status, 302);
        assert.match(cb.headers.get('location') ?? '', /^\/login\?error=/);
      }
      const denied = await fetch(`${API}/api/auth/microsoft/callback?error=access_denied`, { redirect: 'manual' });
      assert.match(decodeURIComponent(denied.headers.get('location') ?? ''), /cancelled/);
    });

    await step('ID token checks: issuer, tenant, audience, nonce, expiry', async () => {
      const { claimsFromIdToken } = await import('../modules/auth/microsoft.ts');
      const good = {
        iss: `https://login.microsoftonline.com/${ms.tenantId}/v2.0`,
        tid: ms.tenantId,
        aud: ms.clientId,
        exp: Math.floor(Date.now() / 1000) + 600,
        nonce: 'n1',
        oid: 'oid-1',
        email: 'a@b.test',
      };
      const token = (c: object) => `x.${Buffer.from(JSON.stringify(c)).toString('base64url')}.sig`;
      const expect = { tenantId: ms.tenantId, clientId: ms.clientId, nonce: 'n1' };
      assert.equal(claimsFromIdToken(token(good), expect).oid, 'oid-1');
      const otherTenant = '11111111-1111-4111-8111-111111111111';
      assert.throws(
        () => claimsFromIdToken(token({ ...good, iss: `https://login.microsoftonline.com/${otherTenant}/v2.0` }), expect),
        /issuer/,
      );
      assert.throws(() => claimsFromIdToken(token({ ...good, tid: otherTenant }), expect), /tenant/);
      assert.throws(() => claimsFromIdToken(token({ ...good, aud: 'another-app' }), expect), /audience/);
      assert.throws(() => claimsFromIdToken(token({ ...good, nonce: 'replayed' }), expect), /nonce/);
      assert.throws(() => claimsFromIdToken(token({ ...good, exp: 1 }), expect), /expired/);
    });

    await step('staff sync: links teammates (also by alias), adds active staff as members, skips auto-imported', async () => {
      staffList = [
        { id: 'st-member', name: 'E2E Member', email: `member-${tag}@e2e.test` },
        { id: 'st-reader', name: 'E2E Reader', email: `reader.alt-${tag}@e2e.test`, email_aliases: [`reader-${tag}@e2e.test`] },
        { id: 'st-sam', name: 'Sam Staff', email: `sam-${tag}@e2e.test` },
        { id: 'st-auto', name: 'Auto Import', email: `auto-${tag}@e2e.test`, auto_imported: true },
        { id: 'st-gone', name: 'Left Long Ago', email: `gone-${tag}@e2e.test`, resigned_at: new Date().toISOString() },
      ];
      const r = await syncNow();
      assert.equal(r.ok, true, r.error);
      assert.equal(r.provisioned, 1);
      assert.equal((await userByEmail(`member-${tag}@e2e.test`)).staffId, 'st-member');
      assert.equal((await userByEmail(`reader-${tag}@e2e.test`)).staffId, 'st-reader');
      const sam = await userByEmail(`sam-${tag}@e2e.test`);
      assert.equal(sam.role, 'MEMBER');
      assert.equal(sam.source, 'staff_sync');
      assert.equal(sam.passwordHash, null, 'Microsoft sign-in only');
      if (config.defaultGrant === 'NONE') assert.equal((await sql`SELECT 1 FROM account_grants WHERE user_id = ${sam.id}`).length, 0);
      assert.equal(await userByEmail(`auto-${tag}@e2e.test`), undefined);
      assert.equal(await userByEmail(`gone-${tag}@e2e.test`), undefined);
      const listed = (await owner('GET', '/api/users')).data.find((u: any) => u.id === sam.id);
      assert.equal(listed.source, 'staff_sync');
      assert.equal(listed.hasPassword, false);
      const pw = await client()('POST', '/api/auth/login', { email: `sam-${tag}@e2e.test`, password: 'whatever-123' });
      assert.equal(pw.status, 401, 'same answer as a wrong password (no account enumeration)');
      assert.match(pw.data.error, /Microsoft/);
      const unknown = await client()('POST', '/api/auth/login', { email: `nobody-${tag}@e2e.test`, password: 'whatever-123' });
      assert.equal(unknown.data.error, pw.data.error);
      assert.equal((await sql`SELECT 1 FROM audit_log WHERE action = 'user.provisioned' AND meta->>'targetUserId' = ${sam.id}`).length, 1);
      assert.equal((await owner('POST', '/api/users/directory/sync')).status, 200);
      assert.equal((await member('POST', '/api/users/directory/sync')).status, 403);
    });

    await step('staff sync: a resignation disables and signs out at once; undoing it re-enables', async () => {
      assert.equal((await reader('GET', '/api/me')).status, 200);
      staffList[1].resigned_at = new Date().toISOString();
      const r = await syncNow();
      assert.equal(r.disabled, 1);
      const u = await userByEmail(`reader-${tag}@e2e.test`);
      assert.ok(u.disabledAt);
      assert.equal(u.disabledBy, 'staff_sync');
      assert.equal(u.disabledReason, 'Resigned in the Twilio console');
      assert.equal((await reader('GET', '/api/me')).status, 401, 'signed out everywhere');
      const [a] = await sql`SELECT user_id, meta FROM audit_log WHERE action = 'user.deprovisioned' ORDER BY id DESC LIMIT 1`;
      assert.equal(a.userId, null, 'done by the system');
      assert.equal(a.meta.targetUserId, readerId);

      staffList[1].resigned_at = null;
      assert.equal((await syncNow()).reenabled, 1);
      assert.equal((await userByEmail(`reader-${tag}@e2e.test`)).disabledAt, null);
      assert.equal((await reader('POST', '/api/auth/login', { email: `reader-${tag}@e2e.test`, password })).status, 200);
    });

    await step('staff sync: an archived record is checked one by one; admin-disabled people stay disabled', async () => {
      const memberEntry = staffList.splice(0, 1)[0];
      staffById.set('st-member', { ...memberEntry, archived_at: new Date().toISOString() });
      assert.equal((await syncNow()).disabled, 1);
      assert.equal((await userByEmail(`member-${tag}@e2e.test`)).disabledReason, 'Archived in the Twilio console');
      staffList.unshift(memberEntry);
      staffById.clear();
      assert.equal((await syncNow()).reenabled, 1);
      // Someone an admin disabled is not re-enabled by the sync.
      const sam = await userByEmail(`sam-${tag}@e2e.test`);
      await owner('PATCH', `/api/users/${sam.id}`, { disabled: true });
      assert.equal((await syncNow()).reenabled, 0);
      assert.equal((await userByEmail(`sam-${tag}@e2e.test`)).disabledBy, 'admin');
    });

    await step('staff sync refuses to act on an empty list or a mass resignation', async () => {
      const saved = staffList;
      staffList = [];
      const empty = await syncNow();
      assert.equal(empty.ok, false);
      assert.match(empty.error, /empty/);
      // Six linked people, all suddenly resigned: refused, nobody disabled.
      staffList = [...saved, ...[1, 2, 3].map((i) => ({ id: `st-x${i}`, name: `Extra ${i}`, email: `extra${i}-${tag}@e2e.test` }))];
      assert.equal((await syncNow()).provisioned, 3);
      staffList = staffList.map((s) => ({ ...s, resigned_at: new Date().toISOString() }));
      const mass = await syncNow();
      assert.equal(mass.ok, false);
      assert.match(mass.error, /would disable/);
      assert.equal(
        (await sql`SELECT count(*)::int AS n FROM users WHERE disabled_by = 'staff_sync' AND email LIKE ${`%${tag}@e2e.test`}`)[0].n,
        0,
      );
      staffList = saved;
    });
    if (config.twenty?.url === 'http://api:4100/graphql') {
      const twentySync = () => runStaffSync({ source: 'twenty' });
      await step('staff from Twenty: workspace members become staff (every page), removal disables, return re-enables', async () => {
        twentyMembers = [
          { id: `m1-${tag}`, name: 'E2E Member', email: `member-${tag}@e2e.test` },
          { id: `m2-${tag}`, name: 'Tina Twenty', email: `tina-${tag}@e2e.test` },
          { id: `m3-${tag}`, name: 'Theo Twenty', email: `theo-${tag}@e2e.test` },
        ];
        const first = await twentySync();
        assert.equal(first.ok, true, first.error);
        assert.equal(first.staff, 3, 'all pages read');
        assert.equal(first.provisioned, 2);
        const tina = await userByEmail(`tina-${tag}@e2e.test`);
        assert.equal(tina.role, 'MEMBER');
        assert.equal(tina.staffId, `twenty:m2-${tag}`);
        assert.equal(tina.passwordHash, null, 'Microsoft 365 only');
        assert.equal((await userByEmail(`member-${tag}@e2e.test`)).staffId, `twenty:m1-${tag}`, 'linked by email');
        // Linked to the Twilio list before and not in Twenty: left alone (another source is not a removal).
        assert.equal((await userByEmail(`reader-${tag}@e2e.test`)).disabledAt, null);

        twentyMembers = twentyMembers.filter((m) => m.id !== `m2-${tag}`);
        assert.equal((await twentySync()).disabled, 1);
        const gone = await userByEmail(`tina-${tag}@e2e.test`);
        assert.ok(gone.disabledAt);
        assert.equal(gone.disabledReason, 'Removed from the Twenty workspace');
        twentyMembers.push({ id: `m2-${tag}`, name: 'Tina Twenty', email: `tina-${tag}@e2e.test` });
        assert.equal((await twentySync()).reenabled, 1);
        assert.equal((await userByEmail(`tina-${tag}@e2e.test`)).disabledAt, null);
      });
      await step('staff from Twenty: an error or an empty workspace changes nothing', async () => {
        twentyFails = true;
        const failed = await twentySync();
        assert.equal(failed.ok, false);
        assert.match(failed.error ?? '', /Forbidden/);
        twentyFails = false;
        const saved = twentyMembers;
        twentyMembers = [];
        const empty = await twentySync();
        assert.equal(empty.ok, false);
        assert.equal((await userByEmail(`tina-${tag}@e2e.test`)).disabledAt, null);
        twentyMembers = saved;
      });
    } else {
      console.log('  (Twenty staff tests skipped: they need TWENTY_API_URL=http://api:4100/graphql, see docs/development.md)');
    }
  } else {
    console.log('  (Microsoft sign-in and staff sync tests skipped: they need the e2e identity settings, see docs/development.md)');
  }
} catch (e) {
  results.push({ name: 'setup', ok: false, error: (e as Error).message });
  console.log(`✘ setup failed
    ${(e as Error).stack}`);
} finally {
  await cleanup().catch((e) => console.error('cleanup failed', e));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed || !results.length ? 1 : 0);
}
