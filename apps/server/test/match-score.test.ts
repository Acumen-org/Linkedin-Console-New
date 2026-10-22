import assert from 'node:assert/strict';
import test from 'node:test';
import { type Candidate, decide, type Prospect, rankCandidates, scoreCandidate } from '../src/lib/match-score.ts';

const cand = (p: Partial<Candidate>): Candidate => ({
  id: p.id ?? 'c1',
  name: p.name ?? '',
  linkedin: p.linkedin ?? null,
  jobTitle: p.jobTitle ?? null,
  company: p.company ?? null,
});

test('exact LinkedIn link is the only 100 (however the URL is typed)', () => {
  const p: Prospect = { name: 'Jane Doe', profileUrl: 'https://www.linkedin.com/in/jane-doe/', headline: null };
  assert.equal(scoreCandidate(p, cand({ name: 'Totally Different', linkedin: 'linkedin.com/in/JANE-DOE?trk=x' })).score, 100);
  // No link on the candidate falls through to name scoring, not 100.
  assert.ok(scoreCandidate(p, cand({ name: 'Someone Else', linkedin: null })).score < 100);
});

test('exact name needs corroboration to score high; name alone stays well under the threshold', () => {
  const p: Prospect = { name: 'Matthew Lakus', profileUrl: null, headline: 'Commercial Account Executive @ Datadog' };
  assert.equal(scoreCandidate(p, cand({ name: 'Matthew Lakus', company: 'Datadog' })).score, 92);
  assert.equal(scoreCandidate(p, cand({ name: 'Matthew Lakus', jobTitle: 'Account Executive' })).score, 85);
  assert.equal(scoreCandidate(p, cand({ name: 'Matthew Lakus' })).score, 70);
});

test('weak signals score low — a shared prefix or same last name can never reach auto-bind', () => {
  const p: Prospect = { name: 'Nicolas Fernandez', profileUrl: null, headline: null };
  // The screenshot's false match: "Nicolas Fernandez -> Nicole Barile, share prefix nicol".
  const nicole = scoreCandidate(p, cand({ name: 'Nicole Barile' }));
  assert.ok(nicole.score <= 45, `shared prefix should be weak, got ${nicole.score}`);
  assert.ok(nicole.score < 80, 'a shared prefix must never reach any auto-bind threshold');
  // Same last name + first initial is a hint, still far below threshold.
  assert.equal(scoreCandidate(p, cand({ name: 'Nina Fernandez' })).score, 55);
});

test('decide: one clear winner auto-binds; ties and sub-threshold go to options', () => {
  const opts = { threshold: 90, margin: 15 };
  const ranked = (scores: number[]) => scores.map((s, i) => ({ ...cand({ id: `c${i}` }), score: s, reason: '' }));
  // Clear winner at/above threshold with margin.
  assert.equal(decide(ranked([92, 55]), opts).action, 'auto');
  // Two exact links (both 100): ambiguous, no margin -> options, never auto.
  assert.equal(decide(ranked([100, 100]), opts).action, 'options');
  // Top below threshold -> options.
  assert.equal(decide(ranked([70, 45]), opts).action, 'options');
  // Winner too close to runner-up -> options.
  assert.equal(decide(ranked([92, 85]), opts).action, 'options');
  // Nothing worth showing.
  assert.equal(decide(ranked([20]), opts).action, 'none');
  assert.equal(decide([], opts).action, 'none');
});

test('rankCandidates sorts best-first and the weak false match never wins auto', () => {
  const p: Prospect = {
    name: 'Nicolas Fernandez',
    profileUrl: 'https://www.linkedin.com/in/nicolas-fernandez/',
    headline: 'VP Sales @ Acme',
  };
  const ranked = rankCandidates(p, [
    cand({ id: 'wrong', name: 'Nicole Barile' }),
    cand({ id: 'right', name: 'Nicolas Fernandez', linkedin: 'https://www.linkedin.com/in/nicolas-fernandez' }),
  ]);
  assert.equal(ranked[0].id, 'right');
  assert.equal(ranked[0].score, 100);
  assert.equal(decide(ranked, { threshold: 90, margin: 15 }).action, 'auto');
  assert.equal(decide(ranked, { threshold: 90, margin: 15 }).top?.id, 'right');
});
