/** The stable part of a LinkedIn profile URL ("linkedin.com/in/jane-doe"), lowercased, for matching however the link
 * was typed (with or without https, www, a trailing slash or tracking params). Pure and dependency-free so the match
 * scorer and its tests can use it without pulling in the Twenty client or config. */
export function linkedinKey(url: string | null | undefined): string | null {
  const m = String(url ?? '').match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) return null;
  let slug = m[1];
  try {
    slug = decodeURIComponent(slug);
  } catch {} // a malformed %-sequence: compare it as typed
  return `linkedin.com/in/${slug.toLowerCase()}`;
}
