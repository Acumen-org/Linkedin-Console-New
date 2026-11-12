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

// ── Preferred path: parse LinkedIn's own search JSON ────────────────────────────────────────────────
// The people-search page fetches its results as a Voyager response (voyagerSearchDashClusters). That body is
// normalized: a flat `included` array of typed entities, one `…EntityResultViewModel` per result. Reading those
// structured fields is far more robust than scraping the rendered DOM (no mutual-connection / "also viewed" noise,
// no reliance on class names or a visible degree badge). search.ts intercepts the response and hands the parsed
// JSON here; the DOM scraper (above) stays only as a fallback for when the response isn't seen.

/** The visible string of a LinkedIn TextViewModel (`{ text }`) or a bare string; null when empty. */
function tvmText(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (v && typeof v === 'object' && typeof (v as { text?: unknown }).text === 'string') {
    return ((v as { text: string }).text || '').trim() || null;
  }
  return null;
}

/** The fsd_profile member URN for a result (from its entity/tracking URN, else its /in/ link), or null. */
function profileUrn(e: Record<string, unknown>, nav: string): string | null {
  for (const field of [e.entityUrn, e.trackingUrn, e.dashEntityUrn]) {
    const m = typeof field === 'string' ? field.match(/urn:li:fsd_profile:([A-Za-z0-9_-]+)/) : null;
    if (m) return `urn:li:fsd_profile:${m[1]}`;
  }
  return memberUrnFromHref(nav);
}

/** The largest avatar URL under an ImageViewModel (vectorImage rootUrl + widest artifact), else the first media URL. */
function imageUrl(img: unknown): string | null {
  let best: string | null = null;
  let bestWidth = -1;
  const visit = (v: unknown) => {
    if (!v || bestWidth === Number.POSITIVE_INFINITY) return;
    if (typeof v === 'string') {
      if (best === null && /^https:\/\/[^"']*licdn\.com/.test(v)) best = v;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const root = typeof o.rootUrl === 'string' ? o.rootUrl : null;
      if (root && Array.isArray(o.artifacts)) {
        for (const a of o.artifacts as Record<string, unknown>[]) {
          const seg = a.fileIdentifyingUrlPathSegment;
          const w = Number(a.width) || 0;
          if (typeof seg === 'string' && w > bestWidth) {
            bestWidth = w;
            best = root + seg;
          }
        }
      }
      for (const val of Object.values(o)) visit(val);
    }
  };
  visit(img);
  return best;
}

/** Total result count anywhere in the response metadata, or null. */
function totalFrom(json: unknown): number | null {
  try {
    const m = JSON.stringify(json).match(/"totalResultCount":\s*(\d+)/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Parse LinkedIn's people-search response into result rows. Defensive: unknown shapes yield []. */
export function parseSearchJson(json: unknown): { results: SearchResult[]; total: number | null } {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const included = Array.isArray((json as { included?: unknown })?.included)
    ? ((json as { included: unknown[] }).included as Record<string, unknown>[])
    : [];
  for (const e of included) {
    if (!e || typeof e !== 'object') continue;
    // Match by SHAPE, not a `$type` discriminator (its exact name drifts between LinkedIn releases): a person result is
    // any entity that navigates to a /in/<id> profile and has a title (its name). Company/job/school results navigate
    // elsewhere; cluster headers and other view models have no /in/ navigationUrl. This keeps the parser release-proof.
    const nav = (typeof e.navigationUrl === 'string' ? e.navigationUrl : '').split('?')[0];
    if (!/\/in\//.test(nav)) continue;
    const name = tvmText(e.title);
    if (!name) continue;
    const memberUrn = profileUrn(e, nav);
    const key = memberUrn ?? nav;
    if (seen.has(key)) continue;
    seen.add(key);
    const badge = tvmText(e.badgeText);
    results.push({
      memberUrn,
      name: name.slice(0, 200),
      headline: tvmText(e.primarySubtitle),
      location: tvmText(e.secondarySubtitle),
      degree: badge ? degreeFromLines([badge]) : null,
      profileUrl: profileUrlFromHref(nav),
      avatarUrl: imageUrl(e.image),
    });
  }
  return { results, total: totalFrom(json) };
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
