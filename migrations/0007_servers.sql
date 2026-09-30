-- Servers (Discord style): members, roles, categories, text channels and their messages.
-- "Realtime" is polling (see src/routes/servers.ts), so the tables below are shaped for one cheap
-- indexed poll per open channel: new messages by id, changed/deleted messages by updated_at,
-- typing by `until`, presence by last_seen_at.

-- ── Servers and members ───────────────────────────────────────────────────

CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invite_code TEXT NOT NULL UNIQUE,
  member_count INTEGER NOT NULL DEFAULT 0,
  -- Bumped whenever channels, categories, roles or the server itself change, so polling clients
  -- know to reload the server's structure.
  structure_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX servers_owner ON servers(owner_id);

CREATE TABLE server_members (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_members_user ON server_members(user_id, joined_at);

-- The @everyone role has id = server id and position 0; every member has it implicitly.
-- Higher position = higher rank. permissions is a bitmask (see PERMS in src/routes/servers.ts):
-- 1 manage_server, 2 manage_channels, 4 manage_roles, 8 kick_members, 16 ban_members,
-- 32 manage_messages, 64 mention_everyone.
CREATE TABLE server_roles (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  colour TEXT,                          -- stored for compatibility; the interface is greyscale
  position INTEGER NOT NULL DEFAULT 0,
  permissions INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX server_roles_server ON server_roles(server_id, position);

CREATE TABLE server_member_roles (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id)
);
CREATE INDEX server_member_roles_role ON server_member_roles(role_id);

CREATE TABLE server_bans (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  banned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

-- Presence per server: refreshed by the channel poll at most every 30 s; "online" = seen in 60 s.
CREATE TABLE server_presence (
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_presence_seen ON server_presence(server_id, last_seen_at);

-- ── Channels ──────────────────────────────────────────────────────────────

CREATE TABLE channel_categories (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX channel_categories_server ON channel_categories(server_id, position);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES channel_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,                   -- lowercase-with-dashes
  topic TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'announcement')),
  position INTEGER NOT NULL DEFAULT 0,
  slowmode_seconds INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,                 -- newest message id, for unread flags
  created_at INTEGER NOT NULL
);
CREATE INDEX channels_server ON channels(server_id, position);

CREATE TABLE channel_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  mention_everyone INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_at INTEGER,
  edited_at INTEGER,
  deleted_at INTEGER,
  -- Set on every change after creation (edit, delete, pin, reactions) so polls can pick it up.
  updated_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX channel_messages_channel ON channel_messages(channel_id, id DESC);
CREATE INDEX channel_messages_author ON channel_messages(channel_id, author_id, id DESC);
CREATE INDEX channel_messages_updated ON channel_messages(channel_id, updated_at) WHERE updated_at IS NOT NULL;
CREATE INDEX channel_messages_pinned ON channel_messages(channel_id, pinned_at DESC) WHERE pinned = 1;
CREATE INDEX channel_messages_everyone ON channel_messages(channel_id, id) WHERE mention_everyone = 1;

-- Reactions are words (like, agree, laugh, thanks, wow, sad). One row per person per word.
CREATE TABLE channel_reactions (
  message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reaction TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, reaction)
);

-- Explicit @handle mentions (and replies), for mention counts. @everyone is a flag on the message.
CREATE TABLE channel_mentions (
  message_id TEXT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX channel_mentions_user ON channel_mentions(user_id, channel_id, message_id);

CREATE TABLE channel_reads (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE channel_typing (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  until INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
