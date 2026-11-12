-- Accepted-connection tracking (ext plan C2): when a connection first appears, and a per-account marker for when the
-- first full connection sync finished — so the baseline of existing connections doesn't each emit an "accepted" event.
ALTER TABLE contacts ADD COLUMN connected_seen_at timestamptz;
ALTER TABLE accounts ADD COLUMN connections_synced_at timestamptz;
