-- Full-history backfill: when a conversation has been paged back to its first message, this is set so the
-- backfill never revisits it. NULL = still needs (or never ran) a deep backfill. The paging cursor itself is
-- just the oldest message already stored (min(messages.sent_at)), so no separate cursor column is needed.
ALTER TABLE conversations ADD COLUMN history_backfilled_at timestamptz;
