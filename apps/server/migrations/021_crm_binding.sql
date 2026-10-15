-- Twenty CRM, duplicates prevented instead of merged: a prospect reaches Twenty only after they reply and are
-- bound to exactly one Twenty Person, automatically only on an exact LinkedIn profile-link match, otherwise by a
-- person's decision. A binding belongs to the prospect (their LinkedIn member URN), not the conversation, so
-- every conversation with them (any account, any teammate) goes to the same Person.
CREATE TABLE crm_bindings (
  member_urn  text PRIMARY KEY,
  person_id   text NOT NULL,
  -- auto_link: exactly one Person had their profile link; existing / new: chosen by a teammate; legacy: from
  -- the sync before this rule (the prospect had replied).
  method      text NOT NULL CHECK (method IN ('auto_link', 'existing', 'new', 'legacy')),
  bound_by    text REFERENCES users(id) ON DELETE SET NULL,
  bound_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_bindings_person ON crm_bindings (person_id);

ALTER TABLE conversations
  -- NULL: not decided yet (no reply, or not looked at yet); needed: waiting for a teammate to bind it;
  -- bound: twenty_person_id is the prospect's Person.
  ADD COLUMN crm_binding text CHECK (crm_binding IN ('needed', 'bound')),
  ADD COLUMN crm_binding_reason text,
  ADD COLUMN crm_binding_at timestamptz,
  -- A Person the earlier sync created for a prospect who never replied: to be marked for review in Twenty.
  ADD COLUMN crm_review_person_id text,
  ADD COLUMN crm_review_marked_at timestamptz;
CREATE INDEX conversations_crm_undecided ON conversations (account_id) WHERE crm_binding IS NULL AND NOT is_group;

-- The earlier sync created Persons on the first message and could match by name alone. Prospects who replied
-- keep their Person (legacy binding); the others are unlinked and their Person goes to review (nothing deleted).
WITH replied AS (
  SELECT DISTINCT ON (c.participants->0->>'urn') c.participants->0->>'urn' AS member_urn, c.twenty_person_id
  FROM conversations c
  WHERE c.twenty_person_id IS NOT NULL AND NOT c.is_group AND c.participants->0->>'urn' LIKE 'urn:li:%'
    AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'INBOUND')
  ORDER BY c.participants->0->>'urn', c.last_message_at DESC NULLS LAST
)
INSERT INTO crm_bindings (member_urn, person_id, method) SELECT member_urn, twenty_person_id, 'legacy' FROM replied
ON CONFLICT DO NOTHING;
-- First the review cases: a Person no binding keeps (no reply, a group chat, or a second Person the earlier sync
-- made for the same prospect in another account: a duplicate).
UPDATE conversations c SET crm_review_person_id = c.twenty_person_id
WHERE c.twenty_person_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM crm_bindings b WHERE b.member_urn = c.participants->0->>'urn' AND b.person_id = c.twenty_person_id AND NOT c.is_group);
UPDATE conversations SET twenty_person_id = NULL WHERE twenty_person_id IS NOT NULL;
-- Then every conversation with a bound prospect points at their one Person.
UPDATE conversations c SET crm_binding = 'bound', crm_binding_at = now(), twenty_person_id = b.person_id
FROM crm_bindings b WHERE b.member_urn = c.participants->0->>'urn' AND NOT c.is_group;
-- Reminders of unbound prospects keep their Twenty task, if any; new tasks wait for a binding.
