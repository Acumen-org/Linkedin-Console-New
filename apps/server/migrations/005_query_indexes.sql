-- Indexes matched to the inbox queries (measured on 30 accounts / 60k conversations / 1.8M messages).

-- Inbox lists sort newest first with never-active conversations last (DESC NULLS LAST). The original
-- indexes sorted the other way (DESC = NULLS FIRST), so every list read and sorted all conversations.
DROP INDEX IF EXISTS conversations_account_id_last_message_at_idx;
DROP INDEX IF EXISTS conversations_last_message_at_idx;
CREATE INDEX conversations_account_recent ON conversations (account_id, last_message_at DESC NULLS LAST, id);
-- The default "All" view across accounts.
CREATE INDEX conversations_inbox_recent ON conversations (last_message_at DESC NULLS LAST, id)
  WHERE NOT is_archived AND folder NOT IN ('archived', 'spam');
-- "Unread" view, and the unread badges on the accounts list (summed from the index alone).
CREATE INDEX conversations_unread_recent ON conversations (last_message_at DESC NULLS LAST, id)
  WHERE unread_count > 0 AND NOT is_archived;
CREATE INDEX conversations_unread_by_account ON conversations (account_id) INCLUDE (unread_count)
  WHERE unread_count > 0 AND NOT is_archived;

-- Search by name/title (ILIKE '%term%').
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX conversations_search ON conversations USING gin ((coalesce(title, '') || ' ' || participants::text) gin_trgm_ops);
