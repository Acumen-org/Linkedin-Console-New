// The conversation list as the page shows it: a fallback that doesn't depend on LinkedIn's JSON. Each listed
// thread link (/messaging/thread/<threadId>/) becomes a conversation with the name and picture shown; LinkedIn's
// own data replaces these details whenever it comes through (same conversation URN, so no duplicates).
import type { LiConversation } from '@linkedin-console/contracts';

/** What a conversation card shows: its thread link, its lines of text, its picture. */
export interface DomThread {
  path: string;
  lines: string[];
  avatarUrl: string | null;
}

/** Times and dates the list shows next to a name ("5:22 AM", "Oct 12", "Yesterday", "Mon", "2w"). */
const TIME_LIKE =
  /^(\d{1,2}:\d{2}\s?(AM|PM)?|yesterday|today|now|(mon|tue|wed|thu|fri|sat|sun)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(, \d{4})?|\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d+\s?[mhdwy])$/i;
/** Labels and counters that are not the name. */
const NOT_A_NAME = /^(sponsored|inmail|active now|\d+|new|unread|•)$/i;

export function threadIdFromPath(path: string): string | null {
  const m = path.match(/\/messaging\/thread\/([^/?#]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** The name on a card: its first line that isn't a time, a label or a counter. */
export function nameFromLines(lines: string[]): string | null {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || TIME_LIKE.test(line) || NOT_A_NAME.test(line)) continue;
    // "Status is online" and similar screen-reader texts.
    if (/^status is /i.test(line)) continue;
    return line.slice(0, 200);
  }
  return null;
}

/** Conversations for the threads the page lists, for the ones LinkedIn's data didn't bring (`known`). */
export function conversationsFromPage(threads: DomThread[], selfUrn: string, known: Set<string>): LiConversation[] {
  const out: LiConversation[] = [];
  const seen = new Set<string>();
  for (const t of threads) {
    const threadId = threadIdFromPath(t.path);
    // "new" is the compose link, not a conversation.
    if (!threadId || threadId === 'new' || seen.has(threadId)) continue;
    seen.add(threadId);
    const urn = `urn:li:msg_conversation:(${selfUrn},${threadId})`;
    if (known.has(urn)) continue;
    const name = nameFromLines(t.lines);
    out.push({
      urn,
      threadId,
      title: null,
      isGroup: null,
      unreadCount: null,
      lastActivityAt: timeFromLines(t.lines),
      folder: null,
      // Placeholder participant (no LinkedIn id from the page): replaced when LinkedIn's data comes through.
      participants: name ? [{ urn: `page:${threadId}`, name, avatarUrl: t.avatarUrl }] : [],
    });
  }
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The time a card shows for its last message, roughly (for ordering the list until LinkedIn's data brings the
 * exact time): "5:22 AM" today, "Yesterday", "Mon" this week, "Oct 12" (this year, or last year if that would be
 * in the future), "Oct 12, 2025". In the browser's local time. Null when no line looks like a time.
 */
export function timeFromLines(lines: string[], now = new Date()): number | null {
  for (const raw of lines) {
    const line = raw.trim().toLowerCase();
    let m = line.match(/^(\d{1,2}):(\d{2})\s?(am|pm)?$/);
    if (m) {
      let h = Number(m[1]) % 12;
      if (m[3] === 'pm' || (!m[3] && Number(m[1]) >= 12)) h += 12;
      const d = new Date(now);
      d.setHours(h, Number(m[2]), 0, 0);
      return d.getTime();
    }
    if (line === 'yesterday') {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      d.setHours(12, 0, 0, 0);
      return d.getTime();
    }
    const day = DAYS.indexOf(line.slice(0, 3));
    if (day >= 0 && /^[a-z]+$/.test(line)) {
      const d = new Date(now);
      d.setDate(d.getDate() - ((d.getDay() - day + 7) % 7 || 7));
      d.setHours(12, 0, 0, 0);
      return d.getTime();
    }
    m = line.match(/^([a-z]{3})[a-z]*\.? (\d{1,2})(?:, (\d{4}))?$/);
    if (m && MONTHS.includes(m[1])) {
      const d = new Date(m[3] ? Number(m[3]) : now.getFullYear(), MONTHS.indexOf(m[1]), Number(m[2]), 12);
      if (!m[3] && d > now) d.setFullYear(d.getFullYear() - 1);
      return d.getTime();
    }
  }
  return null;
}
