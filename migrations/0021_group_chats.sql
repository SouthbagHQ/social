-- Group chats (the messaging kind, not the public/private "groups" feature): member roles,
-- invite links, pinned messages and @mentions. All additive; existing 1:1s and support
-- conversations keep role 'member' and simply never use it.

ALTER TABLE conversation_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'; -- owner | admin | member

-- Creators of existing group chats become their owners.
UPDATE conversation_members SET role = 'owner' WHERE EXISTS (
  SELECT 1 FROM conversations c
  WHERE c.id = conversation_members.conversation_id AND c.is_group = 1 AND c.created_by = conversation_members.user_id);

-- Invite links: anyone signed in with the code joins the chat (blocks and the member cap still apply).
CREATE TABLE conversation_invites (
  code TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX conversation_invites_conversation ON conversation_invites(conversation_id);

CREATE TABLE message_pins (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, message_id)
);

-- One row per mentioned member per message, so a message JSON can name who was mentioned.
CREATE TABLE message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX message_mentions_user ON message_mentions(user_id);
