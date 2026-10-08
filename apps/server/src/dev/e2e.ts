// End-to-end test of api + worker + database + Redis, with a fake bridge (no LinkedIn, no pod).
//   docker compose exec api node src/dev/e2e.ts
// Creates temporary users/account and removes them afterwards. Exit code 0 = all passed.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { Redis } from 'ioredis';
import { hashPassword } from '../core/auth.ts';
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

// Webhook receiver inside this process; the worker container reaches it by this container's hostname.
const received: { event: string; signature: string; legacySignature: string; body: string }[] = [];
const receiver = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/staff')) return fakeTwilio(req, res);
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
  return async function call(method: string, path: string, body?: unknown) {
    const res = await fetch(API + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const json = res.headers.get('content-type')?.includes('json');
    const text = json ? '' : await res.text();
    const data = json ? await res.json() : null;
    return { status: res.status, data: data as any, text, headers: res.headers };
  };
}

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
      if (cmd.type !== 'send_message' || cmd.text.startsWith('[silent]')) continue;
      const echo = msg(cmd.threadId.replace(/^2-/, '').replace(tag, ''), null, cmd.text, Date.now());
      const ok = { cmdId: cmd.cmdId, type: cmd.type, ok: true };
      const failed = { cmdId: cmd.cmdId, type: cmd.type, ok: false, error: 'Could not confirm the message was sent' };
      if (cmd.text.startsWith('[fast]')) {
        await emitResult(ok);
        setTimeout(() => emit('messages', [echo]), 200);
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

  await step('search finds messages by text', async () => {
    const r = await owner('GET', `/api/conversations?accountId=${accountId}&view=all&q=${encodeURIComponent('hello')}`);
    assert.equal(r.data.length, 1);
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

  await step('new chats from Network obey pause and the daily cap', async () => {
    const start = () => member('POST', `/api/accounts/${accountId}/connections/${janeContactId}/message`, { text: 'Hello from Network' });
    assert.equal((await start()).status, 409, 'paused (from the previous step)');
    await sql`UPDATE accounts SET send_paused = false, daily_send_cap = 1 WHERE id = ${accountId}`;
    assert.equal((await start()).status, 429, 'cap reached');
    await sql`UPDATE accounts SET daily_send_cap = 80 WHERE id = ${accountId}`;
    assert.equal((await start()).status, 200);
  });

  let labelId = '';
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

  await step('config + push subscription endpoints', async () => {
    const cfg = await member('GET', '/api/config');
    assert.ok(cfg.data.vapidPublicKey, 'VAPID key generated');
    assert.equal(cfg.data.features.aiDrafts, false);
    const sub = { endpoint: `https://push.example.invalid/${tag}`, keys: { p256dh: 'x', auth: 'y' } };
    assert.equal((await member('POST', '/api/push/subscriptions', sub)).status, 200);
    assert.equal((await member('DELETE', '/api/push/subscriptions', { endpoint: sub.endpoint })).status, 200);
    assert.equal((await member('POST', `/api/conversations/${janeId}/draft`, {})).status, 404, 'AI drafts off by default');
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
      { urn: conv('RAJ'), threadId: `2-RAJ${tag}`, title: null, isGroup: null, unreadCount: null, folder: null, lastActivityAt: null, participants: [] },
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
