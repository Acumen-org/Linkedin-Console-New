-- Who a teammate is in Twenty and which pod they belong to (master plan L2): a Person a teammate adds gets them
-- as owner and their pod; binding to an existing Person fills these only where empty.
ALTER TABLE users
  ADD COLUMN twenty_member_id text,
  ADD COLUMN pod text;
-- From the Twenty staff list (STAFF_SOURCE=twenty) the member is already known.
UPDATE users SET twenty_member_id = substring(staff_id FROM 8) WHERE staff_id LIKE 'twenty:%';

-- A reply waiting for a binding: the teammate responsible is nudged once after a business day.
ALTER TABLE conversations ADD COLUMN crm_nudged_at timestamptz;
CREATE INDEX conversations_crm_needed ON conversations (crm_binding_at) WHERE crm_binding = 'needed';
