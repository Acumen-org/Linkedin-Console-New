-- Safe sending volume per LinkedIn account.
ALTER TABLE accounts
  -- New chats (cold outreach) are the risky part: their own, lower daily cap within the overall one.
  ADD COLUMN new_chat_cap integer NOT NULL DEFAULT 20,
  -- Newly connected accounts start low and ramp up to their cap; restarted after a LinkedIn warning.
  -- NULL = no ramp (accounts that existed before this, or turned off).
  ADD COLUMN ramp_started_at timestamptz,
  -- Why sending was paused automatically (a LinkedIn limit or restriction warning).
  ADD COLUMN paused_reason text;
