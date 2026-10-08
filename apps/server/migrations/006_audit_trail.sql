-- Audit trail for a large team: names as they were at the time, the browser used, filter indexes,
-- and protection against edits.

-- Who and which account, as named when it happened: history stays readable after a teammate or a
-- LinkedIn account is removed or renamed (the user_id / account_id links are cleared on removal).
ALTER TABLE audit_log
  ADD COLUMN actor_name    text,
  ADD COLUMN actor_email   text,
  ADD COLUMN account_label text,
  ADD COLUMN user_agent    text;
UPDATE audit_log l SET actor_name = u.name, actor_email = u.email FROM users u WHERE u.id = l.user_id;
UPDATE audit_log l SET account_label = a.label FROM accounts a WHERE a.id = l.account_id;

-- Filters: by person, account, action (each newest first) and by time (existing created_at index).
CREATE INDEX audit_log_by_user ON audit_log (user_id, id DESC);
CREATE INDEX audit_log_by_account ON audit_log (account_id, id DESC);
CREATE INDEX audit_log_by_action ON audit_log (action, id DESC);

-- Append-only: an entry can't be changed or deleted through the app's database user. The only change
-- allowed is clearing the link to a teammate or account that was removed (ON DELETE SET NULL).
-- (A database superuser can still disable this; it guards against application bugs and injection.)
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.user_id IS NOT DISTINCT FROM OLD.user_id OR NEW.user_id IS NULL)
     AND (NEW.account_id IS NOT DISTINCT FROM OLD.account_id OR NEW.account_id IS NULL)
     AND (NEW.id, NEW.action, NEW.meta, NEW.ip, NEW.created_at, NEW.actor_name, NEW.actor_email, NEW.account_label, NEW.user_agent)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.action, OLD.meta, OLD.ip, OLD.created_at, OLD.actor_name, OLD.actor_email, OLD.account_label, OLD.user_agent)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only (% not allowed)', TG_OP;
END
$$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
