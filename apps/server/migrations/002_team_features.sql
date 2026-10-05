-- Labels, snooze, saved replies, webhooks, web push, generated settings.

CREATE TABLE settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);

CREATE TABLE labels (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  color       text NOT NULL DEFAULT '#64748b',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_labels (
  conversation_id  text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  label_id         text NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (conversation_id, label_id)
);
CREATE INDEX ON conversation_labels (label_id);

ALTER TABLE conversations ADD COLUMN snoozed_until timestamptz;
CREATE INDEX ON conversations (snoozed_until) WHERE snoozed_until IS NOT NULL;

CREATE TABLE templates (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL,
  body        text NOT NULL,
  shared      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhooks (
  id                text PRIMARY KEY,
  url               text NOT NULL,
  secret            text NOT NULL,
  events            text[] NOT NULL,
  active            boolean NOT NULL DEFAULT true,
  last_status       integer,
  last_error        text,
  last_delivery_at  timestamptz,
  created_by        text REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_subscriptions (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  keys        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON push_subscriptions (user_id);
