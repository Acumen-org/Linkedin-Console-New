-- The LinkedIn summary written on each bound prospect's Person, and one "LinkedIn conversation" record per bound
-- conversation in Twenty: what was last written (hash) and when it was last looked at, so only changes are sent.
ALTER TABLE crm_bindings
  ADD COLUMN fields_hash text,
  ADD COLUMN fields_checked_at timestamptz;
ALTER TABLE conversations
  ADD COLUMN twenty_record_id text,
  ADD COLUMN twenty_record_hash text,
  ADD COLUMN twenty_record_checked_at timestamptz;
-- "Every conversation with this prospect" (bindings, summaries) by LinkedIn member URN.
CREATE INDEX conversations_prospect ON conversations ((participants->0->>'urn')) WHERE NOT is_group;
