-- Which LinkedIn account an uploaded attachment was sent through, so checking a teammate's access to it is a
-- direct lookup instead of searching every message's attachments.
ALTER TABLE uploads ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE CASCADE;
UPDATE uploads u SET account_id = m.account_id
FROM messages m, jsonb_array_elements(m.attachments) att
WHERE m.sent_by_user_id IS NOT NULL AND att->>'uploadId' = u.id;
