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

test('parseSearchJson walks the whole tree — nested GraphQL shape (no flat `included`)', () => {
  // The GraphQL content-type returns results nested under data.…elements[].items[].item, NOT a top-level `included`.
  // Walking the whole tree (like extract.ts) is what makes this work; the old `json.included`-only parser returned [].
  const json = {
    data: {
      data: {
        searchDashClustersByAll: {
          metadata: { totalResultCount: 7 },
          elements: [
            {
              items: [
                {
                  item: {
                    entityResult: {
                      _type: 'com.linkedin.voyager.dash.search.EntityResultViewModel',
                      entityUrn: 'urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAABob,SEARCH,DEFAULT)',
                      navigationUrl: 'https://www.linkedin.com/in/bob-smith?miniProfileUrn=y',
                      title: { text: 'Bob Smith' },
                      primarySubtitle: { text: 'Engineer at Foo' },
                      secondarySubtitle: { text: 'Berlin, Germany' },
                      entityCustomTrackingInfo: { memberDistance: 'DISTANCE_3' },
                      image: {
                        attributes: [
                          {
                            detailData: {
                              nonEntityProfilePicture: {
                                vectorImage: {
                                  rootUrl: 'https://media.licdn.com/i/',
                                  artifacts: [{ width: 200, fileIdentifyingUrlPathSegment: 'bob.jpg' }],
                                },
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  };
  const { results, total } = parseSearchJson(json);
  assert.equal(total, 7);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    memberUrn: 'urn:li:fsd_profile:ACoAABob',
    name: 'Bob Smith',
    headline: 'Engineer at Foo',
    location: 'Berlin, Germany',
    degree: 3,
    profileUrl: 'https://www.linkedin.com/in/bob-smith/',
    avatarUrl: 'https://media.licdn.com/i/bob.jpg',
  });
});

test('parseSearchJson reads navigationContext.url when there is no inline navigationUrl', () => {
  const { results } = parseSearchJson({
    included: [{ navigationContext: { url: 'https://www.linkedin.com/in/ACoAACarol' }, title: { text: 'Carol' } }],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Carol');
  assert.equal(results[0].memberUrn, 'urn:li:fsd_profile:ACoAACarol');
});

test('parseSearchJson matches by shape, not a $type name (release-proof)', () => {
  // No $type at all: a person is any entity with a /in/ navigationUrl and a title.
  const { results } = parseSearchJson({
    included: [
      { navigationUrl: 'https://www.linkedin.com/in/ACoAAXYZ', title: { text: 'Raj K' }, primarySubtitle: { text: 'Buyer' } },
      { navigationUrl: 'https://www.linkedin.com/company/acme', title: { text: 'Acme' } },
      { navigationUrl: 'https://www.linkedin.com/in/ACoAAXYZ', title: 'Raj K' }, // duplicate (bare-string title) → deduped
    ],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'Raj K');
  assert.equal(results[0].headline, 'Buyer');
  assert.equal(results[0].memberUrn, 'urn:li:fsd_profile:ACoAAXYZ');
  assert.equal(results[0].profileUrl, null);
});

test('parseSearchJson is defensive about unexpected shapes', () => {
  assert.deepEqual(parseSearchJson(null), { results: [], total: null });
  assert.deepEqual(parseSearchJson({}), { results: [], total: null });
  assert.deepEqual(parseSearchJson({ included: 'nope' }), { results: [], total: null });
  assert.deepEqual(parseSearchJson({ included: [null, 42, { foo: 'bar' }] }), { results: [], total: null });
});
