// Dev tool: pretends to be an account's bridge, so the inbox can be tested without LinkedIn.
//   docker compose exec api node src/dev/simulate.ts <accountId>
// Stop the real sidecar first (docker stop pod-<id>-sidecar), or it will overwrite the status.
// It seeds demo conversations, then answers send commands like a real bridge would.
import { Redis } from 'ioredis';

const accountId = process.argv[2];
if (!accountId) { console.error('usage: simulate.ts <accountId>'); process.exit(1); }
const redis = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');
const blocking = new Redis(process.env.REDIS_URL ?? 'redis://redis:6379');

const SELF = 'urn:li:fsd_profile:SIMSELF';
const conv = (id: string) => `urn:li:msg_conversation:(${SELF},2-${id})`;
const emit = (type: string, data: unknown) => redis.xadd('li:events', '*', 'json', JSON.stringify({ accountId, type, data, at: Date.now() }));
const person = (urn: string, name: string, headline: string) => ({ urn, name, headline, avatarUrl: null, profileUrl: `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s/g, '-')}/` });

const jane = person('urn:li:fsd_profile:JANE', 'Jane Cooper', 'VP Engineering at Acme');
const raj = person('urn:li:fsd_profile:RAJ', 'Raj Patel', 'Founder at Northwind');
const now = Date.now();
let seq = 0;
const msg = (c: string, from: typeof jane | null, text: string, minutesAgo: number, extra = {}) => ({
  urn: `urn:li:msg_message:(${SELF},2-SIM${++seq}${Date.now()})`, conversationUrn: conv(c), text, sentAt: now - minutesAgo * 60_000,
  senderUrn: from?.urn ?? SELF, senderName: from?.name ?? 'Sim Self', senderAvatarUrl: null, fromSelf: !from, attachments: [], reactions: [], ...extra,
});

await emit('session', { status: 'CONNECTED', self: { urn: SELF, name: 'Sim Self', headline: 'Head of Sales', publicId: 'sim-self', avatarUrl: null } });
await emit('conversations', [
  { urn: conv('JANE'), threadId: '2-JANE', title: null, isGroup: false, unreadCount: 1, lastActivityAt: now - 5 * 60_000, folder: 'focused', participants: [jane] },
  { urn: conv('RAJ'), threadId: '2-RAJ', title: null, isGroup: false, unreadCount: 0, lastActivityAt: now - 120 * 60_000, folder: 'focused', participants: [raj] },
  { urn: conv('GRP'), threadId: '2-GRP', title: 'Q4 partnership', isGroup: true, unreadCount: 0, lastActivityAt: now - 26 * 60 * 60_000, folder: 'other', participants: [jane, raj] },
]);
await emit('messages', [
  msg('JANE', jane, 'Hi! Thanks for connecting 👋', 60),
  msg('JANE', null, 'Great to meet you Jane. Are you free for a call this week?', 50),
  msg('JANE', jane, 'Sure, Thursday 2pm works. Here is our deck.', 5, { attachments: [{ kind: 'file', name: 'Acme-overview.pdf', size: 482113, mime: 'application/pdf', url: null }], reactions: [{ emoji: '👍', count: 1, viewerReacted: false }] }),
  msg('RAJ', raj, 'Can you send me the pricing sheet?', 130),
  msg('RAJ', null, 'Sent it over by email, let me know!', 120),
  msg('GRP', jane, 'Kicking off the Q4 thread here.', 26 * 60),
  msg('GRP', raj, 'Sounds good, I will share numbers tomorrow.', 26 * 60 - 3),
]);
await emit('contacts', { connections: true, items: [
  { urn: jane.urn, publicId: 'jane-cooper', name: jane.name, headline: jane.headline, avatarUrl: null, profileUrl: jane.profileUrl },
  { urn: raj.urn, publicId: 'raj-patel', name: raj.name, headline: raj.headline, avatarUrl: null, profileUrl: raj.profileUrl },
] });
console.log('[sim] seeded demo data; now answering commands (Ctrl+C to stop)');

// Heartbeat so the worker doesn't mark the account OFFLINE.
setInterval(() => emit('session', { status: 'CONNECTED', self: null }), 60_000);

// Behave like a bridge: confirm sends, echo LinkedIn's copy of the message, then simulate a reply.
let last = '$';
for (;;) {
  const res = (await blocking.xread('BLOCK', 5000, 'STREAMS', `li:cmd:${accountId}`, last)) as [string, [string, string[]][]][] | null;
  for (const [id, fields] of res?.[0]?.[1] ?? []) {
    last = id;
    const cmd = JSON.parse(fields[1]);
    console.log('[sim] command', cmd.type, cmd.threadId ?? '');
    if (cmd.type === 'send_message') {
      await new Promise((r) => setTimeout(r, 1500));
      const echo = { ...msg(cmd.threadId.replace(/^2-/, ''), null, cmd.text, 0), sentAt: Date.now() };
      echo.attachments = (cmd.files ?? []).map((f: { name: string; mime: string }) => ({ kind: f.mime.startsWith('image/') ? 'image' : 'file', name: f.name, mime: f.mime, url: null }));
      await emit('messages', [echo]); // LinkedIn's copy usually arrives before the confirmation
      await emit('result', { cmdId: cmd.cmdId, type: cmd.type, ok: true, messageUrn: echo.urn });
      setTimeout(async () => {
        await emit('typing', [{ conversationUrn: echo.conversationUrn, participantUrn: jane.urn }]);
        await new Promise((r) => setTimeout(r, 3000));
        await emit('seen', [{ messageUrn: echo.urn, seenAt: Date.now(), participantUrn: jane.urn }]);
        await emit('messages', [{ ...msg(cmd.threadId.replace(/^2-/, ''), jane, `Got it: "${cmd.text.slice(0, 40)}"`, 0), sentAt: Date.now() }]);
      }, 2000);
    } else if (cmd.cmdId) {
      await emit('result', { cmdId: cmd.cmdId, type: cmd.type, ok: true });
    }
  }
}
