-- Auditor: can read and export the audit log, nothing else (no LinkedIn accounts, no messages, no team admin).
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('OWNER', 'ADMIN', 'MEMBER', 'AUDITOR'));
