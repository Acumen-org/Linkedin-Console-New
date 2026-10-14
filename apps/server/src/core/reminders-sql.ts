import { sql } from '../lib/db.ts';

/** The teammate responsible for conversation `c` (SQL, alias c): the assignee, else the last one who messaged. */
export const RESPONSIBLE = sql`coalesce(c.assigned_to, (
  SELECT m.sent_by_user_id FROM messages m
  WHERE m.conversation_id = c.id AND m.sent_by_user_id IS NOT NULL ORDER BY m.sent_at DESC LIMIT 1))`;
