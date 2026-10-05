CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER')),
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          text PRIMARY KEY,              -- sha256 of the cookie token
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  ip          text,
  user_agent  text
);
CREATE INDEX ON sessions (user_id);

CREATE TABLE accounts (
  id              text PRIMARY KEY,          -- 12 chars [a-z0-9], also used in pod names
  label           text NOT NULL,
  owner_user_id   text NOT NULL REFERENCES users(id),
  status          text NOT NULL DEFAULT 'PROVISIONING',
  profile_urn     text,
  display_name    text,
  headline        text,
  public_id       text,
  avatar_url      text,
  timezone        text NOT NULL,
  language        text NOT NULL,
  proxy_server    text,
  send_paused     boolean NOT NULL DEFAULT false,
  daily_send_cap  integer NOT NULL DEFAULT 80,
  last_seen_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE account_grants (
  account_id  text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level       text NOT NULL CHECK (level IN ('READ', 'REPLY', 'FULL')),
  PRIMARY KEY (account_id, user_id)
);

CREATE TABLE contacts (
  id            text PRIMARY KEY,
  account_id    text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_id     text NOT NULL,
  member_urn    text,
  name          text NOT NULL,
  headline      text,
  avatar_url    text,
  profile_url   text,
  is_connection boolean NOT NULL DEFAULT false,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, public_id)
);
CREATE INDEX contacts_search ON contacts USING gin (to_tsvector('simple', name || ' ' || coalesce(headline, '')));

CREATE TABLE conversations (
  id                   text PRIMARY KEY,
  account_id           text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  thread_urn           text NOT NULL,
  thread_id            text,
  title                text,
  is_group             boolean NOT NULL DEFAULT false,
  folder               text NOT NULL DEFAULT 'focused',
  participants         jsonb NOT NULL DEFAULT '[]',
  last_message_at      timestamptz,
  last_message_preview text,
  last_message_from_self boolean,
  unread_count         integer NOT NULL DEFAULT 0,
  is_starred           boolean NOT NULL DEFAULT false,
  is_archived          boolean NOT NULL DEFAULT false,
  assigned_to          text REFERENCES users(id) ON DELETE SET NULL,
  locked_by            text REFERENCES users(id) ON DELETE SET NULL,
  locked_until         timestamptz,
  history_synced_at    timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, thread_urn)
);
CREATE INDEX ON conversations (account_id, last_message_at DESC);
CREATE INDEX ON conversations (last_message_at DESC);

CREATE TABLE messages (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id       text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_urn      text UNIQUE,
  client_id        text UNIQUE,
  cmd_id           text UNIQUE,
  direction        text NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  sender_urn       text,
  sender_name      text,
  sender_avatar_url text,
  sent_by_user_id  text REFERENCES users(id) ON DELETE SET NULL,
  text             text NOT NULL DEFAULT '',
  attachments      jsonb NOT NULL DEFAULT '[]',
  reactions        jsonb NOT NULL DEFAULT '[]',
  status           text NOT NULL DEFAULT 'SENT' CHECK (status IN ('QUEUED', 'SENDING', 'SENT', 'FAILED')),
  error            text,
  deleted          boolean NOT NULL DEFAULT false,
  seen_at          timestamptz,
  sent_at          timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON messages (conversation_id, sent_at DESC);
CREATE INDEX messages_search ON messages USING gin (to_tsvector('simple', text));

CREATE TABLE uploads (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path        text NOT NULL,
  name        text NOT NULL,
  mime        text NOT NULL,
  size        integer NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notes (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id          text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text             text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON notes (conversation_id, created_at);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  user_id     text REFERENCES users(id) ON DELETE SET NULL,
  account_id  text REFERENCES accounts(id) ON DELETE SET NULL,
  action      text NOT NULL,
  meta        jsonb NOT NULL DEFAULT '{}',
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (created_at DESC);
