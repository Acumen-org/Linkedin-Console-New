-- Confidence-scored binding (scored-binding plan, phase 3) auto-binds a strong fuzzy match with method 'auto_score'.
-- Allow it in the CHECK before the code can write it (the same drift that broke auto_new — now guarded by an e2e test).
ALTER TABLE crm_bindings DROP CONSTRAINT crm_bindings_method_check;
ALTER TABLE crm_bindings ADD CONSTRAINT crm_bindings_method_check
  CHECK (method IN ('auto_link', 'auto_new', 'auto_score', 'existing', 'new', 'legacy'));
