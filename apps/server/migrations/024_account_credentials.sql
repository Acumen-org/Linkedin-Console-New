-- LinkedIn login stored per account so the owner logs in rarely: the password is encrypted at rest
-- (AES-256-GCM, CREDENTIALS_KEY) and never leaves the server in plaintext. Used to gate the Live window
-- and to auto re-login when LinkedIn drops the session.
ALTER TABLE accounts ADD COLUMN li_username text;
ALTER TABLE accounts ADD COLUMN li_password_enc text;
