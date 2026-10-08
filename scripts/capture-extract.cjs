// Prints one thread's raw LinkedIn data from the CAPTURE_RAW files: the conversation entity and up to
// 3 of its messages. Run by scripts/capture.sh inside the api container (stdin script).
//   env: ACCOUNT (account id), URN (conversation thread URN)
const fs = require('node:fs');
const path = require('node:path');

const { ACCOUNT, URN } = process.env;
const max = 3;
const dir = path.join('/data/files/capture', ACCOUNT ?? '');
if (!ACCOUNT || !URN) throw new Error('ACCOUNT and URN are required');
if (!fs.existsSync(dir)) {
  console.error(`No captures for ${ACCOUNT} (is capture on, and has the account loaded its inbox since?)`);
  process.exit(1);
}

// Messages point at their conversation by URN; the thread id (2-…) also matches encoded forms.
const threadId = URN.match(/,(2-[^)]+)\)$/)?.[1] ?? URN;
const hit = { conversation: null, conversationFile: null, messages: [] };
let file = '';
const walk = (o) => {
  if (Array.isArray(o)) return o.forEach(walk);
  if (!o || typeof o !== 'object') return;
  const urn = typeof o.entityUrn === 'string' ? o.entityUrn : '';
  // Prefer the richest copy of the conversation (list responses carry more fields than references).
  if (urn === URN && JSON.stringify(o).length > JSON.stringify(hit.conversation ?? '').length) {
    hit.conversation = o;
    hit.conversationFile = file;
  }
  if (urn.startsWith('urn:li:msg_message:') && hit.messages.length < max && JSON.stringify(o).includes(threadId)) {
    if (!hit.messages.some((m) => m.entityUrn === urn)) hit.messages.push(o);
  }
  for (const v of Object.values(o)) walk(v);
};

for (const f of fs.readdirSync(dir).sort()) {
  file = f;
  try {
    walk(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  } catch {}
}
if (!hit.conversation) console.error('Conversation not found in the captures: open the thread in Live View and try again.');
console.log(JSON.stringify(hit, null, 2));
process.exit(hit.conversation ? 0 : 2);
