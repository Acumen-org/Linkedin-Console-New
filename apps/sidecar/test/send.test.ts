// Fast sending: the learned create-message template, and send priority over background work.
// The body below is synthetic, shaped like LinkedIn's web client request (no real data).

import assert from 'node:assert/strict';
import test from 'node:test';
import { createExclusiveRunner } from '../src/bridge/context.ts';
import { fillSendBody, isCreateMessageRequest, scrubSendBody } from '../src/bridge/send-template.ts';

const SELF = 'urn:li:fsd_profile:ACoAASELF';
const CONV = `urn:li:msg_conversation:(${SELF},2-ZTAbc123==)`;
const OTHER = `urn:li:msg_conversation:(${SELF},2-OTHER456==)`;
const URL = 'https://www.linkedin.com/voyager/api/voyagerMessagingDashMessengerMessages?action=createMessage';

const captured = JSON.stringify({
  message: {
    body: {
      attributes: [{ start: 0, length: 4, attributeKindUnion: { entity: { urn: 'urn:li:fsd_profile:X' } } }],
      text: 'Jane, private words',
    },
    renderContentUnions: [],
    conversationUrn: CONV,
    originToken: '1b4e28ba-2fa1-11d2-883f-0016a5d4cafe',
  },
  mailboxUrn: SELF,
  trackingId: 'k3J9lT0xQm2pZ8wA',
  dedupeByClientGeneratedToken: false,
});

test('recognizes LinkedIn create-message requests only', () => {
  assert.ok(isCreateMessageRequest('POST', URL));
  assert.ok(!isCreateMessageRequest('GET', URL));
  assert.ok(!isCreateMessageRequest('POST', 'https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=x'));
});

test('stored template keeps the shape but not the original conversation or text', () => {
  const scrubbed = scrubSendBody(captured)!;
  assert.ok(scrubbed);
  assert.ok(!scrubbed.includes('private words'));
  assert.ok(!scrubbed.includes('2-ZTAbc123'));
  assert.equal(JSON.parse(scrubbed).mailboxUrn, SELF);
});

test('fills a new message: conversation, text, fresh tokens, no leftover mentions', () => {
  const body = JSON.parse(fillSendBody(scrubSendBody(captured)!, OTHER, 'Hello\nsecond line')!);
  assert.equal(body.message.conversationUrn, OTHER);
  assert.equal(body.message.body.text, 'Hello\nsecond line');
  assert.deepEqual(body.message.body.attributes, []);
  assert.match(body.message.originToken, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
  assert.notEqual(body.message.originToken, '1b4e28ba-2fa1-11d2-883f-0016a5d4cafe');
  assert.equal(body.trackingId.length, 16);
  assert.equal(body.dedupeByClientGeneratedToken, false);
  const again = JSON.parse(fillSendBody(scrubSendBody(captured)!, OTHER, 'x')!);
  assert.notEqual(again.message.originToken, body.message.originToken, 'every send gets its own token');
});

test('refuses templates it cannot safely reuse', () => {
  assert.equal(fillSendBody('not json', OTHER, 'x'), null);
  assert.equal(fillSendBody(JSON.stringify({ message: { body: { text: 'a' } } }), OTHER, 'x'), null, 'no conversation');
  const withImage = JSON.parse(captured);
  withImage.message.renderContentUnions = [{ file: { assetUrn: 'urn:li:digitalmediaAsset:1' } }];
  assert.equal(scrubSendBody(JSON.stringify(withImage)), null, 'attachments are never replayed');
});

test('a waiting send runs before queued background work', async () => {
  const exclusive = createExclusiveRunner();
  const order: string[] = [];
  const job = (name: string, ms: number) => async () => {
    await new Promise((r) => setTimeout(r, ms));
    order.push(name);
  };
  const running = exclusive(job('sync-1', 30));
  const queued = [exclusive(job('sync-2', 1)), exclusive(job('sync-3', 1)), exclusive(job('send', 1), 'high')];
  await Promise.all([running, ...queued]);
  assert.deepEqual(order, ['sync-1', 'send', 'sync-2', 'sync-3']);
});

test('a failing job rejects its caller and the queue keeps going', async () => {
  const exclusive = createExclusiveRunner();
  await assert.rejects(
    exclusive(async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(await exclusive(async () => 42), 42);
});

test('history sync encodes the conversation URN like LinkedIn (parentheses too)', async () => {
  const { encodeUrn } = await import('../src/bridge/linkedin.ts');
  assert.equal(
    encodeUrn('urn:li:msg_conversation:(urn:li:fsd_profile:X,2-ab==)'),
    'urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3AX%2C2-ab%3D%3D%29',
  );
});

test('the download limiter never runs more than its limit at once', async () => {
  const { createLimiter } = await import('../src/bridge/context.ts');
  const limit = createLimiter(2);
  let running = 0;
  let peak = 0;
  const job = () =>
    limit(async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 10));
      running--;
    });
  await Promise.all(Array.from({ length: 8 }, job));
  assert.equal(peak, 2);
});
