-- Conversation search by name: only titles and participant names (searching the participants' JSON text
-- matched field names and photo URLs, so "urn" or "media" found every conversation).
CREATE FUNCTION conversation_search_text(title text, participants jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT coalesce($1, '') || ' ' || coalesce((SELECT string_agg(p->>'name', ' ') FROM jsonb_array_elements($2) p), '') $$;

DROP INDEX IF EXISTS conversations_search;
CREATE INDEX conversations_search ON conversations USING gin (conversation_search_text(title, participants) gin_trgm_ops);
