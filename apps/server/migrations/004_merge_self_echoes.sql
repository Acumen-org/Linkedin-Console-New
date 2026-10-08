-- One-time repair: LinkedIn's copies of messages sent from the app that were stored as incoming messages
-- with no sender (shown as "?"), next to the teammate's sent message. Each copy is merged into the sent
-- message it belongs to: same conversation, same text, within 10 minutes, sent message not yet linked.
-- (The worker now recognizes these copies itself; see matchPendingOutbound in worker/ingest.ts.)

CREATE TEMP TABLE echo_pairs ON COMMIT DROP AS
WITH candidates AS (
  SELECT d.id AS echo_id, d.message_urn, o.id AS sent_id,
         row_number() OVER (PARTITION BY d.id ORDER BY abs(extract(epoch FROM d.sent_at - o.created_at))) AS by_echo,
         row_number() OVER (PARTITION BY o.id ORDER BY abs(extract(epoch FROM d.sent_at - o.created_at))) AS by_sent
  FROM messages d
  JOIN messages o ON o.conversation_id = d.conversation_id
    AND o.direction = 'OUTBOUND' AND o.sent_by_user_id IS NOT NULL AND o.message_urn IS NULL
    AND o.text = d.text AND d.text <> ''
    AND abs(extract(epoch FROM d.sent_at - o.created_at)) < 600
  WHERE d.direction = 'INBOUND' AND d.sender_urn IS NULL AND d.sender_name IS NULL AND d.message_urn IS NOT NULL
)
SELECT echo_id, message_urn, sent_id FROM candidates WHERE by_echo = 1 AND by_sent = 1;

DELETE FROM messages WHERE id IN (SELECT echo_id FROM echo_pairs);

UPDATE messages o SET message_urn = p.message_urn, status = 'SENT', error = NULL
FROM echo_pairs p WHERE o.id = p.sent_id;

-- "Awaiting reply" depends on who wrote last.
UPDATE conversations c SET last_message_from_self = (
  SELECT m.direction = 'OUTBOUND' FROM messages m WHERE m.conversation_id = c.id ORDER BY m.sent_at DESC LIMIT 1
)
WHERE c.id IN (SELECT o.conversation_id FROM messages o JOIN echo_pairs p ON p.sent_id = o.id);
