// Confidence-scored matching of a replied LinkedIn prospect to Twenty People (scored-binding plan, phase 1).
// Pure and deterministic — no network, no config — so it is trivially unit-tested and reused in dry-run + later the
// real binding decision. The scorer NEVER decides to create; it only ranks existing candidates. Safety property: a
// weak signal (shared name prefix, same last name) must score well below the auto-bind threshold so it can only ever
// be shown as an option, never auto-bound. The only definitive signal is an exact LinkedIn link (100).
import { linkedinKey } from './linkedin-url.ts';

export interface Prospect {
  name: string;
  profileUrl: string | null;
  headline: string | null;
}

/** A Twenty Person to score the prospect against (the shape searchPeople already returns). */
export interface Candidate {
  id: string;
  name: string;
  linkedin: string | null;
  jobTitle: string | null;
  company: string | null;
}

export interface ScoredCandidate extends Candidate {
  score: number;
  reason: string;
}

const norm = (s: string | null | undefined): string =>
  (s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const words = (s: string | null | undefined): string[] => norm(s).split(' ').filter(Boolean);

/**
 * Score one candidate 0–100 against the prospect:
 *  100  exact LinkedIn link (definitive)
 *   92  exact full name + the candidate's company appears in the prospect's headline
 *   85  exact full name + a role word in common with the headline
 *   70  exact full name only (two people often share a name — not enough on its own)
 *   55  same last name + same first initial
 *   45  first names share a prefix (the weak "share prefix nicol" case) — can only ever be an option
 *    0–20 otherwise
 */
export function scoreCandidate(prospect: Prospect, c: Candidate): ScoredCandidate {
  const pk = linkedinKey(prospect.profileUrl);
  const ck = linkedinKey(c.linkedin);
  if (pk && ck && pk === ck) return { ...c, score: 100, reason: 'LinkedIn link exact match' };

  const pName = norm(prospect.name);
  const cName = norm(c.name);
  if (!pName || !cName) return { ...c, score: 0, reason: 'No name to compare' };

  const headline = norm(prospect.headline);
  const companyWords = words(c.company).filter((w) => w.length >= 3);
  const companyHit = companyWords.length > 0 && companyWords.every((w) => headline.includes(w));
  const roleWords = words(c.jobTitle).filter((w) => w.length >= 4);
  const roleHit = roleWords.some((w) => headline.includes(w));

  if (pName === cName) {
    if (companyHit) return { ...c, score: 92, reason: 'Exact name + same company' };
    if (roleHit) return { ...c, score: 85, reason: 'Exact name + matching role' };
    return { ...c, score: 70, reason: 'Exact name only' };
  }

  const pw = pName.split(' ');
  const cw = cName.split(' ');
  const pFirst = pw[0];
  const cFirst = cw[0];
  const pLast = pw.length > 1 ? pw[pw.length - 1] : '';
  const cLast = cw.length > 1 ? cw[cw.length - 1] : '';
  if (pLast && cLast && pLast === cLast && pFirst[0] === cFirst[0]) {
    return { ...c, score: 55, reason: 'Same last name + first initial' };
  }
  const prefix = Math.min(pFirst.length, cFirst.length, 4);
  if (prefix >= 3 && pFirst.slice(0, prefix) === cFirst.slice(0, prefix)) {
    return { ...c, score: 45, reason: `Names share the prefix "${pFirst.slice(0, prefix)}"` };
  }
  return { ...c, score: 20, reason: 'Weak / unrelated' };
}

/** Candidates scored and sorted best-first (ties keep input order, which searchPeople already biases by link). */
export function rankCandidates(prospect: Prospect, candidates: Candidate[]): ScoredCandidate[] {
  return candidates.map((c) => scoreCandidate(prospect, c)).sort((a, b) => b.score - a.score);
}

export type MatchAction = 'auto' | 'options' | 'none';
export interface MatchDecision {
  action: MatchAction;
  /** The winner when `action === 'auto'`, else null. */
  top: ScoredCandidate | null;
  /** The candidates to show when `action === 'options'` (score ≥ SHOW_MIN), best-first. */
  options: ScoredCandidate[];
}

/** Only matches at or above this are ever worth showing as an option; weaker ones are noise. */
export const SHOW_MIN = 40;

/**
 * The binding decision, kept pure so dry-run can log it and the real path (phase 3) can act on the same logic.
 * `auto` only when there is one clear winner: its score ≥ threshold AND it beats the runner-up by `margin`. This is
 * what stops an ambiguous or tied match (two People with the same link, or two same-named people) from auto-binding.
 */
export function decide(ranked: ScoredCandidate[], opts: { threshold: number; margin: number }): MatchDecision {
  const options = ranked.filter((r) => r.score >= SHOW_MIN);
  if (!ranked.length || ranked[0].score < SHOW_MIN) return { action: 'none', top: null, options: [] };
  const [top, second] = ranked;
  const clearWinner = top.score >= opts.threshold && (!second || top.score - second.score >= opts.margin);
  if (clearWinner) return { action: 'auto', top, options };
  return { action: 'options', top: null, options };
}
