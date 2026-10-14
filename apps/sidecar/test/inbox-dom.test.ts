import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationsFromPage, nameFromLines, threadIdFromPath, timeFromLines } from '../src/bridge/inbox-dom.ts';

const SELF = 'urn:li:fsd_profile:ACoAASELF';

test('thread id from the card link (encoded or not)', () => {
  assert.equal(threadIdFromPath('/messaging/thread/2-ZTAbc123==/'), '2-ZTAbc123==');
  assert.equal(threadIdFromPath('/messaging/thread/2-ZTAbc123%3D%3D/'), '2-ZTAbc123==');
  assert.equal(threadIdFromPath('/messaging/thread/new/'), 'new');
  assert.deepEqual(
    conversationsFromPage([{ path: '/messaging/thread/new/', lines: ['New message'], avatarUrl: null }], SELF, new Set()),
    [],
    'the compose link is not a chat',
  );
  assert.equal(threadIdFromPath('/feed/'), null);
});

test('the name is the first line that is not a time, a label or a counter', () => {
  // As the list shows them (screenshot of the LinkedIn inbox).
  assert.equal(nameFromLines(['Rendy Yankee', '5:22 AM', 'You: test']), 'Rendy Yankee');
  assert.equal(nameFromLines(['Tobi C.', 'Oct 8', 'Sponsored', 'Oxford', 'Leading AI Implementation…']), 'Tobi C.');
  assert.equal(nameFromLines(['Status is online', 'Ahmadun Na’il', 'Sep 19', 'Ahmadun: eh, mbayar']), 'Ahmadun Na’il');
  assert.equal(nameFromLines(['Oct 12', '1', 'LinkedIn', 'LinkedIn Offer']), 'LinkedIn');
  assert.equal(nameFromLines(['Yesterday', 'Mon', '2w']), null);
});

test('conversations for listed threads LinkedIn data did not bring, matching its URNs', () => {
  const threads = [
    { path: '/messaging/thread/2-AAA==/', lines: ['Rendy Yankee', '5:22 AM', 'You: test'], avatarUrl: null },
    { path: '/messaging/thread/2-BBB==/', lines: ['Anshul Rai', 'Sep 15', 'Anshul: Hi'], avatarUrl: 'https://media.licdn.com/x.jpg' },
    { path: '/messaging/thread/2-BBB==/', lines: ['Anshul Rai'], avatarUrl: null }, // same thread twice
  ];
  const known = new Set([`urn:li:msg_conversation:(${SELF},2-AAA==)`]);
  const out = conversationsFromPage(threads, SELF, known);
  assert.equal(out.length, 1, 'only the one LinkedIn data missed, once');
  assert.equal(out[0].urn, `urn:li:msg_conversation:(${SELF},2-BBB==)`);
  assert.equal(out[0].threadId, '2-BBB==');
  assert.deepEqual(out[0].participants, [{ urn: 'page:2-BBB==', name: 'Anshul Rai', avatarUrl: 'https://media.licdn.com/x.jpg' }]);
  // Unknown details stay null: the server keeps what it has.
  assert.equal(out[0].unreadCount, null);
  assert.equal(out[0].folder, null);
});

test('the time a card shows, for ordering', () => {
  const now = new Date(2026, 9, 15, 10, 0); // Thursday 15 Oct 2026, 10:00 local
  assert.equal(timeFromLines(['Rendy Yankee', '5:22 AM', 'You: test'], now), new Date(2026, 9, 15, 5, 22).getTime());
  assert.equal(timeFromLines(['X', '9:42 PM'], now), new Date(2026, 9, 15, 21, 42).getTime());
  assert.equal(timeFromLines(['X', 'Yesterday'], now), new Date(2026, 9, 14, 12).getTime());
  assert.equal(timeFromLines(['X', 'Mon'], now), new Date(2026, 9, 12, 12).getTime());
  assert.equal(timeFromLines(['Tobi C.', 'Oct 8', 'Sponsored'], now), new Date(2026, 9, 8, 12).getTime());
  assert.equal(timeFromLines(['X', 'Dec 20'], now), new Date(2025, 11, 20, 12).getTime(), 'not in the future: last year');
  assert.equal(timeFromLines(['X', 'Mar 3, 2024'], now), new Date(2024, 2, 3, 12).getTime());
  assert.equal(timeFromLines(['Just a name', 'You: hello'], now), null);
});
