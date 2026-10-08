-- First sync of a newly connected account: progress shown to the team until it is done.
ALTER TABLE accounts ADD COLUMN sync_state jsonb;

-- History of a conversation is requested from LinkedIn, then confirmed done by the bridge (history_synced_at).
-- Requests that never complete are retried; before this, a lost request meant no history ever.
ALTER TABLE conversations ADD COLUMN history_requested_at timestamptz;
UPDATE conversations SET history_requested_at = history_synced_at WHERE history_synced_at IS NOT NULL;
CREATE INDEX conversations_history_pending ON conversations (history_requested_at)
  WHERE history_requested_at IS NOT NULL AND history_synced_at IS NULL;
