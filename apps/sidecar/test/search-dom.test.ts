import assert from 'node:assert/strict';
import test from 'node:test';
import { degreeFromLines, memberUrnFromHref, profileUrlFromHref, resultsFromCards } from '../src/bridge/search-dom.ts';

test('degree is read from a card badge', () => {
  assert.equal(degreeFromLines(['Jane Doe', '2nd', 'CEO at Acme']), 2);
  assert.equal(degreeFromLines(['Jane Doe • 3rd', 'CEO']), 3);
  assert.equal(degreeFromLines(['Jane Doe', 'CEO at Acme']), null);
});

test('member URN only for obfuscated ids; vanity URL only for real public ids', () => {
  assert.equal(memberUrnFromHref('/in/ACoAABcdef123'), 'urn:li:fsd_profile:ACoAABcdef123');
  assert.equal(memberUrnFromHref('/in/jane-doe'), null);
  assert.equal(profileUrlFromHref('/in/jane-doe'), 'https://www.linkedin.com/in/jane-doe/');
  assert.equal(profileUrlFromHref('/in/ACoAABcdef123'), null, 'obfuscated id is not a usable vanity link');
  assert.equal(profileUrlFromHref('/feed'), null);
});

test('cards become results: name, headline, location, degree; chrome dropped; dups removed', () => {
  const results = resultsFromCards([
    {
      href: '/in/jane-doe',
      name: 'Jane Doe',
      lines: ['Jane Doe', '2nd', 'CEO at Acme', 'London, England', 'Connect', 'Message'],
      avatarUrl: 'https://img/jane.jpg',
    },
    // Same person again (deduped by href).
    { href: '/in/jane-doe', name: 'Jane Doe', lines: ['Jane Doe'], avatarUrl: null },
    // Obfuscated, no vanity link, no degree, headline only.
    { href: '/in/ACoAAXYZ', name: 'Raj K', lines: ['Raj K', 'Buyer'], avatarUrl: null },
    // No name → skipped.
    { href: '/in/nobody', name: '', lines: [], avatarUrl: null },
  ]);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    memberUrn: null,
    name: 'Jane Doe',
    headline: 'CEO at Acme',
    location: 'London, England',
    degree: 2,
    profileUrl: 'https://www.linkedin.com/in/jane-doe/',
    avatarUrl: 'https://img/jane.jpg',
  });
  assert.equal(results[1].memberUrn, 'urn:li:fsd_profile:ACoAAXYZ');
  assert.equal(results[1].profileUrl, null);
  assert.equal(results[1].headline, 'Buyer');
});
