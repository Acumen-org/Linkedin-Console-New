-- Automatic follow-ups: when our message is the last one and the prospect stays silent for this many business
-- days (weekends don't count), a reminder is created for the teammate responsible. 0 = off for the account.
ALTER TABLE accounts ADD COLUMN followup_days smallint NOT NULL DEFAULT 10 CHECK (followup_days BETWEEN 0 AND 60);
ALTER TABLE reminders
  ADD COLUMN source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
  -- Auto reminders: the time of the last message they follow up on.
  ADD COLUMN trigger_at timestamptz;
ALTER TABLE reminders DROP CONSTRAINT reminders_closed_via_check;
ALTER TABLE reminders ADD CONSTRAINT reminders_closed_via_check CHECK (closed_via IN ('app', 'twenty', 'auto'));
CREATE INDEX reminders_by_conversation ON reminders (conversation_id, created_at DESC);

-- Per-teammate send limit (messages and new chats in 24 hours), on top of each account's own. NULL = the team
-- default (Team page); 0 = no limit for this person.
ALTER TABLE users ADD COLUMN daily_send_cap integer CHECK (daily_send_cap >= 0);
CREATE INDEX audit_log_sends_by_user ON audit_log (user_id, created_at) WHERE action IN ('message.send', 'message.start_chat');
