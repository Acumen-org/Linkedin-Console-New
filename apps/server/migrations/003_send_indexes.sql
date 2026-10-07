-- Daily send cap check, run on every send: messages sent from the app, per account, last 24h.
CREATE INDEX messages_app_sends ON messages (account_id, created_at) WHERE sent_by_user_id IS NOT NULL;

-- Sends still waiting for the account's browser (the worker fails them after 10 minutes).
CREATE INDEX messages_pending_sends ON messages (created_at) WHERE status IN ('QUEUED', 'SENDING');
