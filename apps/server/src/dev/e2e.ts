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

// Webhook receiver inside this process; the worker container reaches it by this container's hostname.
const received: { event: string; signature: string; body: string }[] = [];
const receiver = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    received.push({ event: String(req.headers['x-linkunify-event']), signature: String(req.headers['x-linkunify-signature']), body });
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
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
    return { status: res.status, data: data as any };
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

// Fake bridge: records commands; confirms sends like LinkedIn would (echo first, then result).
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
      if (cmd.type === 'send_message') {
        const echo = msg(cmd.threadId.replace(/^2-/, '').replace(tag, ''), null, cmd.text, Date.now());
        await emit('messages', [echo]);
        await sleep(300);
        await emit('result', { cmdId: cmd.cmdId, type: cmd.type, ok: true, messageUrn: echo.urn });
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
  await sql`DELETE FROM users WHERE id IN ${sql([ownerId, memberId, readerId])}`;
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
    const msgs = await owner('GET', `/api/conversations/${janeId}/messages`);
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
