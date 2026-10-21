-- The bridge between LinkedIn's two ids for the same person. Connections (the network list) only ever expose the
-- VANITY public id ("souravmund"); a conversation's participant is keyed by the OBFUSCATED member URN
-- ("urn:li:fsd_profile:ACoAAC…"). With no link between them, a replier (known by member URN) could never be found
-- among the connections (known by vanity id) nor matched to a Twenty Person (whose LinkedIn links are vanity), so
-- auto-bind never fired. This map, filled from any source that yields BOTH ids (a profile resolution, a future
-- payload that carries both), lets prospectOf turn a member URN into the person's vanity profile link.
CREATE TABLE linkedin_members (
  member_urn  text PRIMARY KEY,   -- urn:li:fsd_profile:ACoAAC…
  public_id   text NOT NULL,      -- the vanity id, e.g. "souravmund"
  -- Where the pair came from, for debugging a wrong mapping: 'resolved' (fetched the member's profile),
  -- 'contact' (a connection row that happened to carry both), 'participant' (a messaging payload that did).
  source      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
-- The backfill of contacts.member_urn joins the map to connection rows by their vanity public id.
CREATE INDEX linkedin_members_public ON linkedin_members (public_id);
