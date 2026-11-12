-- External event feed (ext plan C5): a replayable record of outreach events for an outside consumer, the API keys
-- that read it (hash only), and the invitations table the connection-request tracking (C1) fills.
CREATE TABLE ext_events (
  seq  bigserial PRIMARY KEY,
  type text NOT NULL,
  at   timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL
);
CREATE INDEX ext_events_at ON ext_events (at);

CREATE TABLE ext_api_keys (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,         -- sha256 of the key; the key itself is shown once and never stored
  created_by   text REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE invitations (
  id              text PRIMARY KEY,
  account_id      text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  member_urn      text NOT NULL,
  public_id       text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'withdrawn')),
  sent_at         timestamptz NOT NULL DEFAULT now(),
  sent_by_user_id text REFERENCES users(id),
  withdrawn_at    timestamptz,
  accepted_at     timestamptz,
  source          text NOT NULL CHECK (source IN ('live_view', 'sent_list'))
);
-- At most one pending invitation per account + person.
CREATE UNIQUE INDEX invitations_one_pending ON invitations (account_id, member_urn) WHERE status = 'pending';
CREATE INDEX invitations_account_sent ON invitations (account_id, sent_at);
