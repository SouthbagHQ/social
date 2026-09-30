-- Southbag Social: the social graph, posts and file metadata.
-- File bytes live in the MEDIA database(s); see migrations-media/.
-- IDs are time-sortable text (see src/lib/ids.ts), so ORDER BY id DESC is newest first.

PRAGMA foreign_keys = ON;

-- ── Southbag Identity login ───────────────────────────────────────────────

CREATE TABLE oauth_clients (
  origin TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  return_to TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,                  -- Identity `sub`
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT,
  identity_picture TEXT,                -- picture claim from Identity (URL), used until they upload one
  avatar_media_id TEXT,
  banner_media_id TEXT,
  bio TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0,  -- the Southbag Verified™ bag, which is for sale
  bag_balance INTEGER NOT NULL DEFAULT 0, -- engagement fees owed to Southbag, in cents (a gag, never charged)
  follower_count INTEGER NOT NULL DEFAULT 0,
  following_count INTEGER NOT NULL DEFAULT 0,
  post_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);

-- ── Files ─────────────────────────────────────────────────────────────────
-- Metadata only. Bytes are split into chunks stored in the `shard` database.

CREATE TABLE media (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'video', 'audio')),
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  chunks_received INTEGER NOT NULL DEFAULT 0,
  shard TEXT NOT NULL,                  -- binding name, e.g. MEDIA or MEDIA_1
  width INTEGER,
  height INTEGER,
  duration REAL,                        -- seconds, for video/audio
  poster_id TEXT,                       -- still image for a video
  alt TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'uploading' CHECK (status IN ('uploading', 'ready')),
  created_at INTEGER NOT NULL
);
CREATE INDEX media_owner ON media(owner_id, created_at DESC);
CREATE INDEX media_status ON media(status, created_at);

CREATE TABLE media_shards (
  shard TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL DEFAULT 0
);

-- ── Social graph ──────────────────────────────────────────────────────────

CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);
CREATE INDEX follows_followee ON follows(followee_id, created_at DESC);

-- Facebook-style mutual friendships. One row per pair, requester first.
CREATE TABLE friendships (
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted')),
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  PRIMARY KEY (requester_id, addressee_id)
);
CREATE INDEX friendships_addressee ON friendships(addressee_id, status);

CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

-- ── Groups (Facebook) ─────────────────────────────────────────────────────

CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  avatar_media_id TEXT,
  banner_media_id TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'private')),
  member_count INTEGER NOT NULL DEFAULT 0,
  post_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'pending')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX group_members_user ON group_members(user_id);

-- ── Posts ─────────────────────────────────────────────────────────────────
-- One table for every kind of content:
--   text     tweet-style post (may carry images)
--   photo    Instagram-style photo post (1–10 images, caption in body)
--   video    YouTube-style long video (title + description)
--   short    TikTok-style vertical short video
-- Replies/comments are posts with reply_to_id set (root_id = top of the thread).
-- Reposts are posts with repost_of_id and no body; quotes have both.

CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'photo', 'video', 'short')),
  title TEXT,
  body TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT REFERENCES posts(id) ON DELETE SET NULL,
  root_id TEXT,
  repost_of_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  wall_user_id TEXT REFERENCES users(id) ON DELETE CASCADE, -- posted on someone else's profile wall
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'followers', 'friends')),
  sponsored INTEGER NOT NULL DEFAULT 0,
  reaction_count INTEGER NOT NULL DEFAULT 0,
  reply_count INTEGER NOT NULL DEFAULT 0,
  repost_count INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX posts_author ON posts(author_id, id DESC);
CREATE INDEX posts_reply_to ON posts(reply_to_id, id);
CREATE INDEX posts_root ON posts(root_id, id);
CREATE INDEX posts_repost_of ON posts(repost_of_id);
CREATE INDEX posts_group ON posts(group_id, id DESC);
CREATE INDEX posts_wall ON posts(wall_user_id, id DESC);
CREATE INDEX posts_kind ON posts(kind, id DESC);

CREATE TABLE post_media (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (post_id, position)
);
CREATE INDEX post_media_media ON post_media(media_id);

-- Facebook-style reactions; "like" is the default heart.
CREATE TABLE reactions (
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'like' CHECK (type IN ('like', 'love', 'haha', 'wow', 'sad', 'angry', 'bag')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, user_id)
);
CREATE INDEX reactions_user ON reactions(user_id, created_at DESC);

CREATE TABLE bookmarks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, post_id)
);

CREATE TABLE post_tags (
  tag TEXT NOT NULL COLLATE NOCASE,
  post_id TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tag, post_id)
);
CREATE INDEX post_tags_recent ON post_tags(created_at DESC);

-- ── Stories (24 hours, Instagram) ─────────────────────────────────────────

CREATE TABLE stories (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  caption TEXT NOT NULL DEFAULT '',
  background TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX stories_author ON stories(author_id, expires_at);
CREATE INDEX stories_expires ON stories(expires_at);

CREATE TABLE story_views (
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (story_id, viewer_id)
);

-- ── Direct messages ───────────────────────────────────────────────────────

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  is_group INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_message_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user ON conversation_members(user_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT REFERENCES users(id) ON DELETE SET NULL, -- NULL = system message (e.g. Kevin)
  body TEXT NOT NULL DEFAULT '',
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,  -- shared post
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_conversation ON messages(conversation_id, id DESC);

-- ── Notifications ─────────────────────────────────────────────────────────

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- follow, friend_request, friend_accept, reaction, reply, repost, mention, wall_post, group_join, system
  post_id TEXT REFERENCES posts(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  body TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX notifications_user ON notifications(user_id, id DESC);
