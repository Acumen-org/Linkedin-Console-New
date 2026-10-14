-- Twenty CRM: each 1:1 conversation's prospect is a Person there; messages from when the sync was switched on
-- are logged on that person as notes (one per message), retried with a growing pause when Twenty fails.
ALTER TABLE conversations ADD COLUMN twenty_person_id text;
ALTER TABLE messages
  ADD COLUMN crm_note_id text,
  ADD COLUMN crm_synced_at timestamptz,
  ADD COLUMN crm_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN crm_next_at timestamptz,
  ADD COLUMN crm_error text;
CREATE INDEX messages_crm_pending ON messages (created_at) WHERE crm_synced_at IS NULL;

-- Staff activity: what each teammate sent, by time.
CREATE INDEX messages_sent_by ON messages (sent_by_user_id, created_at) WHERE sent_by_user_id IS NOT NULL;
