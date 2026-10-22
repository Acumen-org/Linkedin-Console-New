-- Auto-create (crmAutoCreate) binds a newly created Person with method 'auto_new', but the original CHECK (021)
-- only allowed 'auto_link','existing','new','legacy'. So every auto_new insert violated the constraint and threw:
-- the Person was created in Twenty but never bound, the prospect was reprocessed, and another Person was created —
-- a runaway that produced thousands of orphan People. Allow 'auto_new' so the bind succeeds and the prospect is
-- bound after a single create (no reprocessing, no duplicates).
ALTER TABLE crm_bindings DROP CONSTRAINT crm_bindings_method_check;
ALTER TABLE crm_bindings ADD CONSTRAINT crm_bindings_method_check
  CHECK (method IN ('auto_link', 'auto_new', 'existing', 'new', 'legacy'));
