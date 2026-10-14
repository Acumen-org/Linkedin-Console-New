-- Accounts recover by themselves: a browser that stops reporting (or whose containers are gone or stopped) is
-- restarted, then retried with growing pauses; admins are alerted only when that doesn't bring it back.
ALTER TABLE accounts
  ADD COLUMN recover_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN recover_next_at timestamptz,
  ADD COLUMN last_restart_at timestamptz,
  ADD COLUMN last_restart_reason text,
  -- Since when the browser has been reporting without a break (null while it is down).
  ADD COLUMN online_since timestamptz;
UPDATE accounts SET online_since = last_seen_at WHERE status IN ('CONNECTED', 'AWAITING_LOGIN', 'NEEDS_ATTENTION');
