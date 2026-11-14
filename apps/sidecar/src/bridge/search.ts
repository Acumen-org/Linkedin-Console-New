// People search across LinkedIn (non-connections included), run inside the account's logged-in page — one page
// (~10 results) at a time, driven through the normal search results URL. Results are read from LinkedIn's own
// structured JSON (parseSearchJson), tried from three sources in order of robustness, with DOM scraping last.
//
// Why this shape: a search page load fires SEVERAL voyager requests (typeahead, filters, THEN the results clusters),
// and results may arrive by XHR or be server-rendered into the HTML. So instead of betting on one URL, we collect
// every candidate response/embedded blob, parse each, and keep whichever yields the most people. The JSON is clean by
// construction (one entity per person) — no mutual-connection / "also viewed" noise, no reliance on DOM class names or
// a visible degree badge, which is what made the DOM scraper return duplicate/shifted/empty rows.
//
//   1. Intercepted XHR  — every voyager search/cluster response, parsed; best non-empty wins.
//   2. Embedded model   — the Rest.li data model LinkedIn inlines in <code> blocks (covers server-rendered results).
//   3. DOM scrape       — last resort when no structured data is found at all.
//
// The JSON shape and the DOM are best-effort (see docs/bridge-maintenance.md) and isolated to this file + search-dom.ts.
import type { SearchFilters, SearchPeopleReply, SearchResult } from '@linkedin-console/contracts';
import type { Response } from 'patchright';
import { logger } from '../logger.ts';
import { IDLE_URL } from './actions.ts';
import type { BridgeContext } from './context.ts';
import { type DomCard, parseSearchJson, resultsFromCards } from './search-dom.ts';

const LINKEDIN = 'https://www.linkedin.com';
/** LinkedIn's wording when the free commercial-use / search limit is reached. */
const LIMIT_TEXT = /commercial use limit|reached the (monthly )?limit|search limit/i;
/** A voyager response that MIGHT carry people-search results (typeahead/filters match too; we parse to find out). */
const SEARCH_RESPONSE = /\/voyager\/api\/.*(search|cluster)/i;

interface Parsed {
  results: SearchResult[];
  total: number | null;
}

/** The candidate that found the most people (the results clusters response, not a typeahead), or null if none did. */
function pickBest(candidates: Parsed[]): Parsed | null {
  return candidates.length ? candidates.reduce((a, b) => (b.results.length > a.results.length ? b : a)) : null;
}

/** Fold simple facets into the keyword string — robust across LinkedIn's facet-URN changes (no geo/company URNs). */
export function buildKeywords(keywords: string, f?: SearchFilters): string {
  return [keywords, f?.title, f?.currentCompany, f?.location]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);
}

/** Runs IN THE PAGE: one card per profile link in the results list (self-contained, no imports allowed here). */
function scrapeCards(): DomCard[] {
  const cards: DomCard[] = [];
  const seen = new Set<Element>();
  // Each real result shows a connection-degree badge (1st/2nd/3rd); secondary links inside a card (the photo, mutual
  // connections, "also viewed") do not have their own. So the result card = the nearest ancestor that shows a degree,
  // and every link inside it collapses to that one card — otherwise each secondary link became its own bogus row.
  const DEGREE = /\b(1st|2nd|3rd)\b/i;
  for (const a of Array.from(document.querySelectorAll('a[href*="/in/"]'))) {
    const href = (a.getAttribute('href') || '').split('?')[0];
    if (!/\/in\//.test(href)) continue;
    // The person's name is this link's own text; the photo link has none — skip it so the name link wins the card.
    const name = ((a as HTMLElement).innerText || '').trim().split('\n')[0];
    if (!name) continue;
    let el: Element | null = a.parentElement;
    let card: Element | null = null;
    for (let hops = 0; el && hops < 10; hops++) {
      if (DEGREE.test((el as HTMLElement).innerText || '')) {
        card = el;
        break;
      }
      el = el.parentElement;
    }
    const container = card ?? a;
    if (seen.has(container)) continue;
    seen.add(container);
    const text = ((container as HTMLElement).innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const img = container.querySelector('img');
    cards.push({ href, name, lines: text, avatarUrl: img?.getAttribute('src') ?? null });
  }
  return cards;
}

/** Runs IN THE PAGE: the raw Rest.li data-model JSON blobs LinkedIn inlines in <code> blocks (for SSR'd results). */
function scrapeEmbedded(): string[] {
  const out: string[] = [];
  for (const el of Array.from(document.querySelectorAll('code'))) {
    const t = el.textContent || '';
    // Only blobs that actually look like the normalized search model — not every inlined code block.
    if (t.length > 200 && /"included"/.test(t) && /\/in\//.test(t)) out.push(t);
  }
  return out;
}

/** Search people and return one page of results. Leaves the bridge window back on the idle page afterwards. */
export async function searchPeople(
  ctx: BridgeContext,
  keywords: string,
  filters: SearchFilters | undefined,
  page: number,
): Promise<SearchPeopleReply> {
  const kw = buildKeywords(keywords, filters);
  if (!kw) return { ok: true, results: [], total: 0 };
  const url = `${LINKEDIN}/search/results/people/?keywords=${encodeURIComponent(kw)}&origin=GLOBAL_SEARCH_HEADER&page=${Math.max(1, page)}`;
  return ctx.pageLock(async () => {
    const candidates: Parsed[] = [];
    // Collect + parse EVERY voyager search/cluster response as it arrives; keep only ones that yield people. A
    // typeahead or filter response parses to [] and is ignored; the real results clusters response wins pickBest.
    const onResponse = (r: Response) => {
      void (async () => {
        try {
          if (r.status() !== 200 || !SEARCH_RESPONSE.test(r.url())) return;
          if (!/json|graphql/.test(r.headers()['content-type'] ?? '')) return;
          const parsed = parseSearchJson(await r.json());
          if (parsed.results.length) candidates.push(parsed);
        } catch {}
      })();
    };
    ctx.page.on('response', onResponse);
    try {
      await ctx.page.goto(url, { waitUntil: 'domcontentloaded' });
      const bodyText = await ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (LIMIT_TEXT.test(bodyText)) return { ok: true, results: [], total: null, limited: true };
      // Let the result list render, then give the results XHR a moment to arrive and be parsed by onResponse.
      await ctx.page.waitForSelector('a[href*="/in/"]', { timeout: 15_000 }).catch(() => {});
      await ctx.page.waitForTimeout(1_200);

      // 1) Best intercepted response.
      const fromXhr = pickBest(candidates);
      if (fromXhr) {
        logger.info({ source: 'xhr', results: fromXhr.results.length, responses: candidates.length }, 'search parsed');
        return { ok: true, results: fromXhr.results, total: fromXhr.total };
      }

      // 2) Data model embedded in the page HTML (server-rendered results, no XHR).
      const embedded = await ctx.page.evaluate(scrapeEmbedded).catch(() => [] as string[]);
      for (const raw of embedded) {
        try {
          const parsed = parseSearchJson(JSON.parse(raw));
          if (parsed.results.length) candidates.push(parsed);
        } catch {}
      }
      const fromEmbedded = pickBest(candidates);
      if (fromEmbedded) {
        logger.info({ source: 'embedded', results: fromEmbedded.results.length, blobs: embedded.length }, 'search parsed');
        return { ok: true, results: fromEmbedded.results, total: fromEmbedded.total };
      }

      // 3) Last resort: scrape the rendered DOM.
      const cards = await ctx.page.evaluate(scrapeCards).catch(() => [] as DomCard[]);
      const results = resultsFromCards(cards);
      logger.warn({ source: 'dom', results: results.length, cards: cards.length }, 'search fell back to DOM scrape');
      return { ok: true, results, total: null };
    } finally {
      ctx.page.off('response', onResponse);
      // We already hold the page lock here, so navigate directly (ensureOnLinkedIn would re-take the lock → deadlock).
      await ctx.page.goto(IDLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  });
}
