import assert from 'node:assert/strict';
import test from 'node:test';
import { degreeFromLines, memberUrnFromHref, parseSearchJson, profileUrlFromHref, resultsFromCards } from '../src/bridge/search-dom.ts';

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

test('parseSearchJson reads LinkedIn’s structured search response (people only, deduped)', () => {
  const json = {
    data: { data: { searchDashClustersByAll: { metadata: { totalResultCount: 142 } } } },
    included: [
      // A person result (TextViewModel fields, vanity link, degree badge, vector avatar).
      {
        $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
        entityUrn: 'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAJane,SEARCH,DEFAULT)',
        trackingUrn: 'urn:li:member:98765',
        navigationUrl: 'https://www.linkedin.com/in/jane-doe?miniProfileUrn=x',
        title: { text: 'Jane Doe' },
        primarySubtitle: { text: 'CEO at Acme' },
        secondarySubtitle: { text: 'London, England' },
        badgeText: { text: '• 2nd', accessibilityText: '2nd degree connection' },
        image: {
          attributes: [
            {
              detailData: {
                nonEntityProfilePicture: {
                  vectorImage: {
                    rootUrl: 'https://media.licdn.com/img/',
                    artifacts: [
                      { width: 100, fileIdentifyingUrlPathSegment: 'small.jpg' },
                      { width: 400, fileIdentifyingUrlPathSegment: 'large.jpg' },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
      // A non-person entity (navigates to a company, not /in/) — must be ignored.
      {
        $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
        navigationUrl: 'https://www.linkedin.com/company/acme',
        title: { text: 'Acme Corp' },
      },
      // The same person again (duplicate cluster entry) — deduped by member URN.
      {
        $type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
        entityUrn: 'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAJane,SEARCH,DEFAULT)',
        navigationUrl: 'https://www.linkedin.com/in/jane-doe',
        title: { text: 'Jane Doe' },
      },
      // Not an entity-result at all (a cluster header) — ignored.
      { $type: 'com.linkedin.voyager.dash.search.SearchClusterViewModel', title: { text: 'People' } },
    ],
  };
  const { results, total } = parseSearchJson(json);
  assert.equal(total, 142);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    memberUrn: 'urn:li:fsd_profile:ACoAAJane',
    name: 'Jane Doe',
    headline: 'CEO at Acme',
    location: 'London, England',
    degree: 2,
    profileUrl: 'https://www.linkedin.com/in/jane-doe/',
    avatarUrl: 'https://media.licdn.com/img/large.jpg',
  });
});

test('parseSearchJson is defensive about unexpected shapes', () => {
  assert.deepEqual(parseSearchJson(null), { results: [], total: null });
  assert.deepEqual(parseSearchJson({}), { results: [], total: null });
  assert.deepEqual(parseSearchJson({ included: 'nope' }), { results: [], total: null });
  assert.deepEqual(parseSearchJson({ included: [null, 42, { $type: 'Other' }] }), { results: [], total: null });
});
