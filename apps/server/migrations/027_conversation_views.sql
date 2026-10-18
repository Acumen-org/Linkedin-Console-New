-- Who read which chat and when (not just who sent messages). One row per open, debounced per user+chat so
-- re-renders don't flood it. Used for staff activity reporting, the audit log, and a "seen by" on the thread.
CREATE TABLE conversation_views (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id      text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversation_views_by_user ON conversation_views (user_id, viewed_at);
CREATE INDEX conversation_views_by_account ON conversation_views (account_id, viewed_at);
CREATE INDEX conversation_views_by_conversation ON conversation_views (conversation_id, viewed_at DESC);
