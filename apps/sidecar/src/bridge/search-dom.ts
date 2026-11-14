// Turns raw people-search result cards (scraped from the search results page) into SearchResult rows. Pure, so it
// can be unit-tested without a browser. The scraping itself (search.ts) runs in the page and hands cards here.
import type { SearchResult } from '@linkedin-console/contracts';
import { imageUrl } from './extract.ts';

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
// The people-search page fetches its results as a Voyager response (voyagerSearchDashClusters). Each person is a
// search EntityResultViewModel. Reading those structured fields is far more robust than scraping the rendered DOM (no
// mutual-connection / "also viewed" noise, no reliance on class names or a visible degree badge).
//
// CRUCIAL: we do NOT assume a flat top-level `included` array. Depending on the response's content-type LinkedIn
// returns either the normalized form (`{ data, included: [...] }`) OR the GraphQL form, which nests the entities under
// `data.…searchDashClustersByAll.elements[].items[].item`. So, like extract.ts, we walk the WHOLE tree and recognise a
// person result by its SHAPE — any object that navigates to a /in/<id> profile and has a title — never by a field path
// or a `$type` name (both drift between LinkedIn releases). This reuses extract.ts's proven value helpers.

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
  for (const field of [e.entityUrn, e.trackingUrn, e.dashEntityUrn, e.objectUrn]) {
    const m = typeof field === 'string' ? field.match(/urn:li:fsd_profile:([A-Za-z0-9_-]+)/) : null;
    if (m) return `urn:li:fsd_profile:${m[1]}`;
  }
  return memberUrnFromHref(nav);
}

/** The /in/<id> profile link a result navigates to (inline navigationUrl, or navigationContext.url), or ''. */
function navFrom(e: Record<string, unknown>): string {
  const direct = typeof e.navigationUrl === 'string' ? e.navigationUrl : '';
  const ctx = e.navigationContext as { url?: unknown } | undefined;
  const nested = ctx && typeof ctx.url === 'string' ? ctx.url : '';
  return (direct || nested).split('?')[0];
}

/** Connection degree for a result: its badge text (1st/2nd/3rd), else a DISTANCE_n marker on the entity, else null. */
function degreeFrom(e: Record<string, unknown>): number | null {
  const badge = tvmText(e.badgeText);
  const fromBadge = badge ? degreeFromLines([badge]) : null;
  if (fromBadge) return fromBadge;
  // Dash view models also carry the distance as e.g. "DISTANCE_2" / "SELF" in a tracking/insight field.
  try {
    const blob = JSON.stringify([e.entityCustomTrackingInfo, e.badgeIcon, e.memberDistance, e.distance]);
    const m = blob.match(/DISTANCE_(\d)/);
    if (m) return Number(m[1]);
    if (/"SELF"/.test(blob)) return 1;
  } catch {}
  return null;
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

/** Every object anywhere in the tree (bounded depth, cycle-safe) — mirrors extract.ts's whole-tree walk. */
function walkObjects(root: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  (function walk(v: unknown, depth: number) {
    if (!v || typeof v !== 'object' || depth > 60 || seen.has(v as object)) return;
    seen.add(v as object);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    out.push(v as Record<string, unknown>);
    for (const val of Object.values(v as Record<string, unknown>)) walk(val, depth + 1);
  })(root, 0);
  return out;
}

/** Parse LinkedIn's people-search response into result rows. Defensive: unknown shapes yield []. */
export function parseSearchJson(json: unknown): { results: SearchResult[]; total: number | null } {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const e of walkObjects(json)) {
    // A person result navigates to a /in/<id> profile and has a title (its name). Everything else — company/job/school
    // results, cluster headers, images, tracking blobs — is skipped. Shape only: no field-path or $type assumptions.
    const nav = navFrom(e);
    if (!/\/in\//.test(nav)) continue;
    const name = tvmText(e.title);
    if (!name) continue;
    const memberUrn = profileUrn(e, nav);
    const key = memberUrn ?? nav;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      memberUrn,
      name: name.slice(0, 200),
      headline: tvmText(e.primarySubtitle),
      location: tvmText(e.secondarySubtitle),
      degree: degreeFrom(e),
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
