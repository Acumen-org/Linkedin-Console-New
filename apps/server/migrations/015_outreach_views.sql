-- Outreach views: "Replied" (the prospect wrote back) and "No reply yet" (only our messages so far).
CREATE INDEX messages_inbound_by_conversation ON messages (conversation_id) WHERE direction = 'INBOUND';
CREATE INDEX messages_outbound_by_conversation ON messages (conversation_id) WHERE direction = 'OUTBOUND';
