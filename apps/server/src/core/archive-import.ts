// Import from LinkedIn's "Download my data" archive, merged with what the live sync already has:
//   Connections.csv → the full connection list with "connected on" dates (live names/photos win)
//   messages.csv    → older chat history the live sync never saw (already-synced messages are skipped)
// Columns are found by their header names; a file without the expected columns is refused with the
// columns it does have, rather than imported wrongly. Re-importing the same file adds nothing twice.
import crypto from 'node:crypto';
import { csvRecords } from '../lib/csv.ts';
import { sql } from '../lib/db.ts';
import { newId } from '../lib/ids.ts';
import { redis } from '../lib/redis.ts';

export interface ImportStatus {
  state: 'running' | 'done' | 'failed';
  kind: 'connections' | 'messages' | null;
  processed: number;
  added: number;
  skipped: number;
  error?: string;
  at: string;
}

const statusKey = (accountId: string) => `lu:import:${accountId}`;
const BATCH = 500;

export const importStatus = async (accountId: string): Promise<ImportStatus | null> =>
  JSON.parse((await redis.get(statusKey(accountId))) ?? 'null');

async function setStatus(accountId: string, s: ImportStatus) {
  await redis.set(statusKey(accountId), JSON.stringify(s), 'EX', 7 * 86400);
}

const publicIdOf = (url: string) => {
  const m = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
};

/** "2026-10-07 23:29:11 UTC" (messages.csv) or "08 Oct 2026" (Connections.csv). */
function parseDate(s: string): Date | null {
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|Z)?$/i);
  const t = iso ? Date.parse(`${iso[1]}T${iso[2]}Z`) : Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Message content may hold simple HTML (InMail): keep the text. */
const plainText = (s: string) =>
  /<[a-z][^>]*>/i.test(s)
    ? s
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .trim()
    : s;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const describe = (header: string[]) => `found columns: ${header.filter(Boolean).join(', ') || 'none'}`;

async function importConnections(accountId: string, text: string, progress: (s: Partial<ImportStatus>) => Promise<void>) {
  const parsed = csvRecords(text, ['First Name', 'Last Name', 'URL']);
  if (!parsed) throw new Error('Not a Connections.csv (needs First Name, Last Name and URL columns)');
  let processed = 0;
  let added = 0;
  let skipped = 0;
  let batch: Record<string, unknown>[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const rows = await sql`
      INSERT INTO contacts ${sql(batch as never, 'id', 'accountId', 'publicId', 'name', 'headline', 'profileUrl', 'isConnection', 'connectedAt')}
      ON CONFLICT (account_id, public_id) DO UPDATE SET
        is_connection = true,
        connected_at = coalesce(contacts.connected_at, excluded.connected_at),
        name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END,
        headline = coalesce(nullif(contacts.headline, ''), excluded.headline)
      RETURNING (xmax = 0) AS inserted`;
    added += rows.filter((r) => r.inserted).length;
    batch = [];
    await progress({ processed, added, skipped });
  };
  for (const r of parsed.records) {
    processed++;
    const publicId = publicIdOf(r.url ?? '');
    const name = [r['first name'], r['last name']].filter(Boolean).join(' ').trim();
    if (!publicId || !name) {
      skipped++;
      continue;
    }
    const position = r.position ?? '';
    const company = r.company ?? '';
    batch.push({
      id: newId('ctc'),
      accountId,
      publicId,
      name,
      headline: position && company ? `${position} at ${company}` : position || company || null,
      profileUrl: `https://www.linkedin.com/in/${publicId}/`,
      isConnection: true,
      connectedAt: parseDate(r['connected on'] ?? ''),
    });
    if (batch.length >= BATCH) await flush();
  }
  await flush();
  return { processed, added, skipped };
}

interface ArchiveMessage {
  threadId: string;
  title: string;
  from: string;
  fromUrl: string;
  to: string;
  toUrls: string;
  at: Date;
  text: string;
  folder: string;
}

async function importMessages(accountId: string, text: string, progress: (s: Partial<ImportStatus>) => Promise<void>) {
  const parsed = csvRecords(text, ['CONVERSATION ID', 'FROM', 'DATE', 'CONTENT']);
  if (!parsed) throw new Error('Not a messages.csv (needs CONVERSATION ID, FROM, DATE and CONTENT columns)');
  const [account] = await sql`SELECT profile_urn, public_id FROM accounts WHERE id = ${accountId}`;
  if (!account?.profileUrn) throw new Error('Connect this LinkedIn account first (its profile is needed to place the chats)');
  const selfId = (account.publicId ?? '').toLowerCase();

  // Group by conversation (one lookup of existing messages per conversation).
  const threads = new Map<string, ArchiveMessage[]>();
  let processed = 0;
  let skipped = 0;
  for (const r of parsed.records) {
    processed++;
    const at = parseDate(r.date ?? '');
    const threadId = r['conversation id'];
    if (!threadId || !at) {
      skipped++;
      continue;
    }
    const m: ArchiveMessage = {
      threadId,
      title: r['conversation title'] ?? '',
      from: r.from ?? '',
      fromUrl: r['sender profile url'] ?? '',
      to: r.to ?? '',
      toUrls: r['recipient profile urls'] ?? '',
      at,
      text: plainText(r.content ?? ''),
      folder: (r.folder ?? '').toUpperCase(),
    };
    const list = threads.get(threadId);
    if (list) list.push(m);
    else threads.set(threadId, [m]);
  }

  let added = 0;
  let done = 0;
  for (const [threadId, msgs] of threads) {
    const own = (m: ArchiveMessage) => !!selfId && publicIdOf(m.fromUrl) === selfId;
    let [conv] = await sql`SELECT id FROM conversations WHERE account_id = ${accountId} AND thread_id = ${threadId}`;
    if (!conv) {
      // The other side(s): senders of their messages, recipients of ours.
      const people = new Map<string, { urn: string; name: string; avatarUrl: null; profileUrl: string }>();
      for (const m of msgs) {
        const pairs = own(m)
          ? m.to.split(',').map((name, i) => [name.trim(), m.toUrls.split(',')[i]?.trim() ?? ''])
          : [[m.from, m.fromUrl]];
        for (const [name, url] of pairs) {
          const id = publicIdOf(url);
          if (id && id !== selfId && name)
            people.set(id, { urn: `public:${id}`, name, avatarUrl: null, profileUrl: `https://www.linkedin.com/in/${id}/` });
        }
      }
      const folder = msgs.some((m) => m.folder === 'ARCHIVE') ? 'archived' : msgs.some((m) => m.folder === 'SPAM') ? 'spam' : 'focused';
      [conv] = await sql`
        INSERT INTO conversations (id, account_id, thread_urn, thread_id, title, is_group, folder, participants)
        VALUES (${newId('cnv')}, ${accountId}, ${`urn:li:msg_conversation:(${account.profileUrn},${threadId})`}, ${threadId},
                ${msgs[0].title || null}, ${people.size > 1}, ${folder}, ${sql.json([...people.values()] as never)})
        ON CONFLICT (account_id, thread_urn) DO UPDATE SET thread_id = excluded.thread_id
        RETURNING id`;
    }
    // Already synced live (same text within two minutes) → skip; the same archive twice → skipped by its key.
    const existing = await sql`SELECT text, sent_at FROM messages WHERE conversation_id = ${conv.id}`;
    const seen = existing.map((e) => ({ text: norm(e.text), at: new Date(e.sentAt).getTime() }));
    const rows = [];
    for (const m of msgs) {
      const t = norm(m.text);
      if (seen.some((e) => e.text === t && Math.abs(e.at - m.at.getTime()) <= 120_000)) {
        skipped++;
        continue;
      }
      const key = crypto.createHash('sha1').update(`${threadId}|${m.at.toISOString()}|${m.fromUrl}|${m.text}`).digest('hex');
      const fromId = publicIdOf(m.fromUrl);
      rows.push({
        id: newId('msg'),
        conversationId: conv.id,
        accountId,
        messageUrn: `archive:${key}`,
        direction: own(m) ? 'OUTBOUND' : 'INBOUND',
        senderUrn: fromId ? `public:${fromId}` : null,
        senderName: m.from || null,
        text: m.text,
        status: 'SENT',
        sentAt: m.at,
      });
    }
    for (let i = 0; i < rows.length; i += BATCH) {
      const inserted = await sql`
        INSERT INTO messages ${sql(rows.slice(i, i + BATCH) as never, 'id', 'conversationId', 'accountId', 'messageUrn', 'direction', 'senderUrn', 'senderName', 'text', 'status', 'sentAt')}
        ON CONFLICT (message_urn) DO NOTHING
        RETURNING id`;
      added += inserted.length;
      skipped += Math.min(BATCH, rows.length - i) - inserted.length;
    }
    // The conversation's time and preview follow its newest message (imported ones are older or equal).
    const newest = msgs.reduce((a, b) => (a.at > b.at ? a : b));
    await sql`
      UPDATE conversations SET
        last_message_preview = CASE WHEN last_message_at IS NULL OR last_message_at < ${newest.at} THEN ${newest.text.slice(0, 200)} ELSE last_message_preview END,
        last_message_from_self = CASE WHEN last_message_at IS NULL OR last_message_at < ${newest.at} THEN ${own(newest)} ELSE last_message_from_self END,
        last_message_at = greatest(last_message_at, ${newest.at})
      WHERE id = ${conv.id}`;
    if (++done % 25 === 0) await progress({ processed, added, skipped });
  }
  return { processed, added, skipped };
}

/** Runs one import for an account (the caller checked access). Progress and the result are kept for a week. */
export async function runImport(accountId: string, text: string) {
  const status: ImportStatus = { state: 'running', kind: null, processed: 0, added: 0, skipped: 0, at: new Date().toISOString() };
  const progress = (s: Partial<ImportStatus>) => setStatus(accountId, Object.assign(status, s));
  try {
    const head = text.slice(0, 4000).toLowerCase();
    status.kind = head.includes('conversation id') ? 'messages' : head.includes('first name') ? 'connections' : null;
    await progress({});
    if (!status.kind) {
      const firstRow = text.split(/\r?\n/, 1)[0] ?? '';
      throw new Error(`Not a LinkedIn Connections.csv or messages.csv (${describe(firstRow.split(','))})`);
    }
    const result =
      status.kind === 'connections' ? await importConnections(accountId, text, progress) : await importMessages(accountId, text, progress);
    await progress({ ...result, state: 'done' });
  } catch (e) {
    await progress({ state: 'failed', error: (e as Error).message });
  }
  return status;
}
