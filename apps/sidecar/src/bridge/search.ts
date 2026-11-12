// People search across LinkedIn (non-connections included), run inside the account's logged-in page — one page
// (~10 results) at a time, driven through the normal search results URL.
//
// PRIMARY path: navigating the search URL makes LinkedIn fetch its results as a structured Voyager response
// (voyagerSearchDashClusters). We intercept that response and parse its typed entities (parseSearchJson) — robust,
// no reliance on DOM class names or a visible degree badge, and free of the mutual-connection / "also viewed" noise
// that made DOM scraping return duplicate/empty rows.
// FALLBACK: if that response isn't seen (SSR'd results, a changed endpoint), scrape the rendered DOM (scrapeCards).
// Both the endpoint shape and the DOM are best-effort (see docs/bridge-maintenance.md) and isolated to this file +
// search-dom.ts, so a maintenance pass only touches those two.
import type { SearchFilters, SearchPeopleReply } from '@linkedin-console/contracts';
import { IDLE_URL } from './actions.ts';
import type { BridgeContext } from './context.ts';
import { type DomCard, parseSearchJson, resultsFromCards } from './search-dom.ts';

const LINKEDIN = 'https://www.linkedin.com';
/** LinkedIn's wording when the free commercial-use / search limit is reached. */
const LIMIT_TEXT = /commercial use limit|reached the (monthly )?limit|search limit/i;
/** The Voyager response that carries people-search results (GraphQL voyagerSearchDashClusters, or the REST clusters). */
const SEARCH_RESPONSE = /\/voyager\/api\/.*(search|cluster)/i;

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
    try {
      // Start listening for the results response BEFORE navigating, so we don't miss it.
      const responsePromise = ctx.page
        .waitForResponse((r) => SEARCH_RESPONSE.test(r.url()) && r.status() === 200, { timeout: 20_000 })
        .catch(() => null);
      await ctx.page.goto(url, { waitUntil: 'domcontentloaded' });
      const bodyText = await ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (LIMIT_TEXT.test(bodyText)) return { ok: true, results: [], total: null, limited: true };
      // PRIMARY: parse LinkedIn's structured search JSON.
      const response = await responsePromise;
      if (response) {
        const json = await response.json().catch(() => null);
        const { results, total } = json ? parseSearchJson(json) : { results: [], total: null };
        if (results.length) return { ok: true, results, total };
      }
      // FALLBACK: scrape the rendered DOM (response not seen, or it yielded nothing).
      await ctx.page.waitForSelector('a[href*="/in/"]', { timeout: 10_000 }).catch(() => {});
      const cards = await ctx.page.evaluate(scrapeCards).catch(() => [] as DomCard[]);
      return { ok: true, results: resultsFromCards(cards), total: null };
    } finally {
      // We already hold the page lock here, so navigate directly (ensureOnLinkedIn would re-take the lock → deadlock).
      await ctx.page.goto(IDLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  });
}
