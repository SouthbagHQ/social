-- The activity log and "Your data" (routes/me.ts) look up messages by who sent them.
CREATE INDEX messages_sender ON messages(sender_id, id DESC);
