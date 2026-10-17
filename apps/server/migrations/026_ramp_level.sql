-- Warm-up level: how far a newly connected account has ramped up. It grows one step per *healthy* day
-- (connected, not paused, no LinkedIn warning) instead of by the calendar, and resets on a LinkedIn warning.
-- It drives both the daily send cap and the history-backfill/sync rate, so a new account stays gentle and an
-- established, healthy one speeds up. ramp_started_at IS NULL still means "ramp finished, full rate".
ALTER TABLE accounts ADD COLUMN ramp_level int NOT NULL DEFAULT 0;
-- Keep existing ramping accounts at their current calendar progress so caps don't jump on deploy.
UPDATE accounts SET ramp_level = floor(extract(epoch FROM now() - ramp_started_at) / 86400)::int
  WHERE ramp_started_at IS NOT NULL;
