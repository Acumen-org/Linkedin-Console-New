// Turns raw people-search result cards (scraped from the search results page) into SearchResult rows. Pure, so it
// can be unit-tested without a browser. The scraping itself (search.ts) runs in the page and hands cards here.
import type { SearchResult } from '@linkedin-console/contracts';

/** Raw text/attrs scraped from one people-search result card. */
export interface DomCard {
  /** Profile link: /in/<vanity> or /in/ACoAA… (obfuscated member id). */
  href: string | null;
  name: string | null;
  /** Every visible text line in the card (headline, location, degree badge, action labels…). */
  lines: string[];
  avatarUrl: string | null;
}

const DEGREE = /(^|[•·\s])(1st|2nd|3rd)([\s•·]|$)/i;
// Lines that are UI chrome, not profile info.
const NOISE = /^(connect|message|follow|pending|view full profile|save|·|•|try premium|status is|.*\bdegree connection\b.*)$/i;

/** The connection degree a card shows (1/2/3), or null. */
export function degreeFromLines(lines: string[]): number | null {
  for (const l of lines) {
    const m = l.match(DEGREE);
    if (m) return Number(m[2][0]);
  }
  return null;
}

/** An obfuscated member id in a profile link becomes a member URN; a real vanity id does not. */
export function memberUrnFromHref(href: string | null): string | null {
  const m = href?.match(/\/in\/(ACoA[A-Za-z0-9_-]+)/);
  return m ? `urn:li:fsd_profile:${m[1]}` : null;
}

/** A usable vanity profile URL, or null when the link is only an obfuscated member id (no vanity to link to). */
export function profileUrlFromHref(href: string | null): string | null {
  const m = href?.match(/\/in\/([^/?#]+)/);
  if (!m) return null;
  return /^ACoA/.test(m[1]) ? null : `https://www.linkedin.com/in/${m[1]}/`;
}

export function resultsFromCards(cards: DomCard[]): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const c of cards) {
    const name = c.name?.trim();
    if (!name) continue;
    const key = c.href ?? name;
    if (seen.has(key)) continue;
    seen.add(key);
    // Lines after the name are usually headline then location; drop the name, degree badges and UI chrome.
    const info = c.lines.map((l) => l.trim()).filter((l) => l && l !== name && !NOISE.test(l) && !DEGREE.test(l));
    out.push({
      memberUrn: memberUrnFromHref(c.href),
      name: name.slice(0, 200),
      headline: info[0] ?? null,
      location: info[1] ?? null,
      degree: degreeFromLines(c.lines),
      profileUrl: profileUrlFromHref(c.href),
      avatarUrl: c.avatarUrl,
    });
  }
  return out;
}
