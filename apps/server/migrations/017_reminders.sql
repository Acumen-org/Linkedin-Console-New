-- Follow-up reminders, one open per prospect (conversation). Who it is for follows the conversation: its
-- assignee, else the last teammate who messaged them, else everyone working the account. Mirrored as a Task
-- in Twenty CRM when the CRM sync is on; done or moved on either side, both follow.
CREATE TABLE reminders (
  id               text PRIMARY KEY,
  conversation_id  text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id       text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  due_at           timestamptz NOT NULL,
  note             text,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'CLOSED')),
  created_by       text REFERENCES users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz,
  closed_by        text REFERENCES users(id) ON DELETE SET NULL,
  closed_via       text CHECK (closed_via IN ('app', 'twenty')),
  notified_at      timestamptz,
  twenty_task_id   text,
  twenty_synced_at timestamptz,
  twenty_assignee  text,
  twenty_attempts  smallint NOT NULL DEFAULT 0,
  twenty_error     text
);
CREATE UNIQUE INDEX reminders_one_open ON reminders (conversation_id) WHERE status = 'OPEN';
CREATE INDEX reminders_due ON reminders (due_at) WHERE status = 'OPEN';
CREATE INDEX reminders_twenty_pending ON reminders (updated_at) WHERE twenty_task_id IS NULL OR twenty_synced_at IS NULL OR twenty_synced_at < updated_at;
