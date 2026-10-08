-- Company sign-in (Microsoft 365) and the Twilio console staff list as an identity source.

-- People who only sign in with Microsoft have no password here.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

-- The person's Microsoft Entra object ID, bound at their first Microsoft sign-in. From then on the
-- account is matched by this ID, not by email (emails can be renamed or reassigned).
ALTER TABLE users ADD COLUMN microsoft_oid text UNIQUE;

-- Where the account came from, and the Twilio console staff record it follows (if any).
ALTER TABLE users ADD COLUMN source text NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'staff_sync'));
ALTER TABLE users ADD COLUMN staff_id text UNIQUE;

-- Why an account is disabled. 'staff_sync' marks the ones the sync disabled (and may re-enable).
ALTER TABLE users ADD COLUMN disabled_reason text;
ALTER TABLE users ADD COLUMN disabled_by text;

-- How each session was opened (shown to admins; Microsoft sessions follow the company's MFA policy).
ALTER TABLE sessions ADD COLUMN method text NOT NULL DEFAULT 'password' CHECK (method IN ('password', 'microsoft'));
