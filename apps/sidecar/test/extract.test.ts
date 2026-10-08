// Synthetic fixtures shaped like LinkedIn's messenger data model.
// Replace/extend with anonymized real captures (CAPTURE_RAW=1) as they come in.

import assert from 'node:assert/strict';
import test from 'node:test';
import { extract, parseSse, selfFromConversationUrn, threadIdFromUrn } from '../src/bridge/extract.ts';

const SELF = 'urn:li:fsd_profile:ACoAASELF';
const JANE = 'urn:li:fsd_profile:ACoAAJANE';
const CONV = `urn:li:msg_conversation:(${SELF},2-ZTAbc123==)`;

const participant = (urn: string, first: string, last: string, extra = {}) => ({
  _type: 'com.linkedin.messenger.MessagingParticipant',
  entityUrn: `urn:li:msg_messagingParticipant:${urn}`,
  hostIdentityUrn: urn,
  participantType: {
    member: {
      firstName: { text: first },
      lastName: { text: last },
      headline: { text: `${first}'s headline` },
      profileUrl: `https://www.linkedin.com/in/${first.toLowerCase()}`,
      profilePicture: {
        rootUrl: 'https://media.licdn.com/dms/image/x/',
        artifacts: [
          { width: 100, fileIdentifyingUrlPathSegment: 'small' },
          { width: 400, fileIdentifyingUrlPathSegment: 'big' },
        ],
      },
    },
  },
  ...extra,
});

// Normalized GraphQL-ish response: data references + `included` entities.
const conversationsResponse = {
  data: { data: { messengerConversationsBySyncToken: { '*elements': [CONV] } } },
  included: [
    participant(SELF, 'Me', 'Self'),
    participant(JANE, 'Jane', 'Doe'),
    {
      $type: 'com.linkedin.messenger.Conversation',
      entityUrn: CONV,
      unreadCount: 2,
      read: false,
      groupChat: false,
      lastActivityAt: 1759500000000,
      categories: ['INBOX', 'PRIMARY_INBOX'],
      '*conversationParticipants': [`urn:li:msg_messagingParticipant:${SELF}`, `urn:li:msg_messagingParticipant:${JANE}`],
      messages: { '*elements': ['urn:li:msg_message:(urn:li:fsd_profile:ACoAASELF,2-MSG1)'] },
    },
    {
      $type: 'com.linkedin.messenger.Message',
      entityUrn: 'urn:li:msg_message:(urn:li:fsd_profile:ACoAASELF,2-MSG1)',
      body: { text: 'Hi! Here is the deck' },
      deliveredAt: 1759500000000,
      '*sender': `urn:li:msg_messagingParticipant:${JANE}`,
      '*conversation': CONV,
      renderContent: [
        { file: { name: 'deck.pdf', byteSize: 12345, mediaType: 'application/pdf', url: 'https://www.linkedin.com/dms/prv/doc/1' } },
        {
          vectorImage: {
            rootUrl: 'https://media.licdn.com/dms/image/m/',
            artifacts: [{ width: 800, height: 600, fileIdentifyingUrlPathSegment: 'img800' }],
          },
        },
      ],
      reactionSummaries: [{ emoji: '👍', count: 1, viewerReacted: true }],
    },
  ],
};

// Realtime event (decorated, non-normalized: objects nested directly).
const realtimeEvent = {
  'com.linkedin.realtimefrontend.DecoratedEvent': {
    topic: 'urn:li-realtime:messagesTopic:urn:li-realtime:myself',
    payload: {
      data: {
        doDecorateMessageMessengerRealtimeDecoration: {
          result: {
            _type: 'com.linkedin.messenger.Message',
            entityUrn: 'urn:li:msg_message:(urn:li:fsd_profile:ACoAASELF,2-MSG2)',
            body: { text: 'Sounds great, talk tomorrow' },
            deliveredAt: 1759500100000,
            sender: participant(SELF, 'Me', 'Self'),
            conversation: { _type: 'com.linkedin.messenger.Conversation', entityUrn: CONV },
            renderContent: [],
          },
        },
      },
    },
  },
};

test('helpers', () => {
  assert.equal(threadIdFromUrn(CONV), '2-ZTAbc123==');
  assert.equal(selfFromConversationUrn(CONV), SELF);
});

test('normalized conversations response', () => {
  const x = extract(conversationsResponse);
  assert.equal(x.selfUrn, SELF);
  assert.equal(x.conversations.length, 1);
  const c = x.conversations[0];
  assert.equal(c.threadId, '2-ZTAbc123==');
  assert.equal(c.unreadCount, 2);
  assert.equal(c.folder, 'focused');
  assert.deepEqual(
    c.participants.map((p) => p.name),
    ['Jane Doe'],
  );
  assert.equal(c.participants[0].avatarUrl, 'https://media.licdn.com/dms/image/x/big');

  assert.equal(x.messages.length, 1);
  const m = x.messages[0];
  assert.equal(m.text, 'Hi! Here is the deck');
  assert.equal(m.conversationUrn, CONV);
  assert.equal(m.senderUrn, JANE);
  assert.equal(m.fromSelf, false);
  assert.deepEqual(
    m.attachments.map((a) => a.kind),
    ['file', 'image'],
  );
  assert.equal(m.attachments[1].url, 'https://media.licdn.com/dms/image/m/img800');
  assert.equal(m.reactions[0].emoji, '👍');
});

test('realtime decorated message', () => {
  const x = extract(realtimeEvent, SELF);
  assert.equal(x.messages.length, 1);
  assert.equal(x.messages[0].fromSelf, true);
  assert.equal(x.messages[0].conversationUrn, CONV);
  assert.equal(x.messages[0].text, 'Sounds great, talk tomorrow');
});

test('sender named only by a reference that is not included still identifies our own message', () => {
  // e.g. LinkedIn's reply to a send: the sender participant isn't part of the response.
  const x = extract(
    {
      data: {
        $type: 'com.linkedin.messenger.Message',
        entityUrn: 'urn:li:msg_message:(urn:li:fsd_profile:ACoAASELF,2-MSG3)',
        body: { text: 'what is your name' },
        deliveredAt: 1759500200000,
        '*sender': `urn:li:msg_messagingParticipant:${SELF}`,
        '*conversation': CONV,
      },
    },
    SELF,
  );
  assert.equal(x.messages.length, 1);
  assert.equal(x.messages[0].senderUrn, SELF);
  assert.equal(x.messages[0].fromSelf, true);
  assert.equal(x.messages[0].senderName, null);
});

test('group chat title + typing + seen receipts', () => {
  const x = extract({
    included: [
      {
        $type: 'com.linkedin.messenger.Conversation',
        entityUrn: CONV,
        groupChat: true,
        title: 'Q4 deal room',
        categories: ['SECONDARY_INBOX'],
        conversationParticipants: [participant(JANE, 'Jane', 'Doe')],
      },
      { _type: 'com.linkedin.messenger.RealtimeTypingIndicator', conversation: CONV, typingParticipant: { hostIdentityUrn: JANE } },
      {
        _type: 'com.linkedin.messenger.SeenReceipt',
        seenAt: 1759500200000,
        message: { entityUrn: 'urn:li:msg_message:(x,2-MSG2)' },
        seenByParticipant: { hostIdentityUrn: JANE },
      },
    ],
  });
  assert.equal(x.conversations[0].title, 'Q4 deal room');
  assert.equal(x.conversations[0].isGroup, true);
  assert.equal(x.conversations[0].folder, 'other');
  assert.deepEqual(x.typing[0], { conversationUrn: CONV, participantUrn: JANE });
  assert.equal(x.seen[0].messageUrn, 'urn:li:msg_message:(x,2-MSG2)');
  assert.equal(x.seen[0].participantUrn, JANE);
});

test('profiles (connections pages)', () => {
  const x = extract({
    included: [
      {
        $type: 'com.linkedin.voyager.dash.identity.profile.Profile',
        entityUrn: JANE,
        publicIdentifier: 'jane-doe',
        firstName: 'Jane',
        lastName: 'Doe',
        headline: 'CTO at Acme',
      },
    ],
  });
  assert.deepEqual(x.profiles[0], {
    urn: JANE,
    publicId: 'jane-doe',
    name: 'Jane Doe',
    headline: 'CTO at Acme',
    avatarUrl: null,
    profileUrl: 'https://www.linkedin.com/in/jane-doe/',
  });
});

test('SSE parsing with partial chunks', () => {
  const [p1, rest] = parseSse('data: {"a":1}\n\ndata: {"b"');
  assert.deepEqual(p1, [{ a: 1 }]);
  const [p2] = parseSse(`${rest}:2}\n\n`);
  assert.deepEqual(p2, [{ b: 2 }]);
});
