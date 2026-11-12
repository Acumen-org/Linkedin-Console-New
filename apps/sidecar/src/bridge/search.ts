// People search across LinkedIn (non-connections included), run inside the account's logged-in page — one page
// (~10 results) at a time, driven through the normal search results URL and read from the rendered DOM. This keeps
// us off LinkedIn's drifting internal search GraphQL (which needs a per-release queryId); the search URL is stable.
//
// NOTE: the DOM selectors here are best-effort and have NOT been verified against a real logged-in LinkedIn account
// (see docs/bridge-maintenance.md). The scraping is deliberately resilient (any `/in/` link in the results becomes a
// result, text read line-by-line) and isolated to this file, so a maintenance pass only has to adjust `scrapeCards`
// and search-dom.ts.
import type { SearchFilters, SearchPeopleReply } from '@linkedin-console/contracts';
import { IDLE_URL } from './actions.ts';
import type { BridgeContext } from './context.ts';
import { type DomCard, resultsFromCards } from './search-dom.ts';

const LINKEDIN = 'https://www.linkedin.com';
/** LinkedIn's wording when the free commercial-use / search limit is reached. */
const LIMIT_TEXT = /commercial use limit|reached the (monthly )?limit|search limit/i;

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
  for (const a of Array.from(document.querySelectorAll('a[href*="/in/"]'))) {
    const href = (a.getAttribute('href') || '').split('?')[0];
    if (!/\/in\//.test(href)) continue;
    // Climb to the enclosing result card (a list item), bounded so we never walk the whole page.
    let el: Element | null = a;
    for (let hops = 0; el && el.tagName !== 'LI' && hops < 6; hops++) el = el.parentElement;
    const card = el ?? a;
    if (seen.has(card)) continue;
    seen.add(card);
    const text = ((card as HTMLElement).innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const name = ((a as HTMLElement).innerText || '').trim().split('\n')[0] || text[0] || null;
    const img = card.querySelector('img');
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
      await ctx.page.goto(url, { waitUntil: 'domcontentloaded' });
      const bodyText = await ctx.page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      if (LIMIT_TEXT.test(bodyText)) return { ok: true, results: [], total: null, limited: true };
      // Let the result list render; if nothing shows, return an empty page rather than hanging.
      await ctx.page.waitForSelector('a[href*="/in/"]', { timeout: 15_000 }).catch(() => {});
      const cards = await ctx.page.evaluate(scrapeCards).catch(() => [] as DomCard[]);
      return { ok: true, results: resultsFromCards(cards), total: null };
    } finally {
      // We already hold the page lock here, so navigate directly (ensureOnLinkedIn would re-take the lock → deadlock).
      await ctx.page.goto(IDLE_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  });
}
