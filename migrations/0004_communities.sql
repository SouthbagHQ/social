-- Communities (Reddit style): named communities with members and moderators, threads with
-- up/down votes and nested comments. Kept apart from `posts` so threads never reach the feeds.
-- IDs are time-sortable text (see src/lib/ids.ts), so ORDER BY id DESC is newest first.

CREATE TABLE communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- c/name: 3 to 21 letters, digits or underscores
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  rules TEXT NOT NULL DEFAULT '',             -- one rule per line
  icon_media_id TEXT,
  banner_media_id TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_count INTEGER NOT NULL DEFAULT 0,
  thread_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX communities_popular ON communities(member_count DESC, id DESC);

CREATE TABLE community_members (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (community_id, user_id)
);
CREATE INDEX community_members_user ON community_members(user_id, community_id);
CREATE INDEX community_members_role ON community_members(community_id, role);

-- hot = sign(score) * log10(max(|score|, 1)) + created_seconds / 45000, refreshed on every vote.
CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'link', 'image')),
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  score INTEGER NOT NULL DEFAULT 0,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  hot REAL NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,          -- taken down by a moderator
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER                           -- deleted by the author
);
CREATE INDEX threads_community_new ON threads(community_id, id DESC);
CREATE INDEX threads_community_hot ON threads(community_id, hot DESC);
CREATE INDEX threads_community_top ON threads(community_id, score DESC, id DESC);
CREATE INDEX threads_hot ON threads(hot DESC);
CREATE INDEX threads_author ON threads(author_id, id DESC);

CREATE TABLE thread_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES thread_comments(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL DEFAULT 0,            -- 0 for top-level comments, at most 5
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX thread_comments_thread ON thread_comments(thread_id, id);
CREATE INDEX thread_comments_parent ON thread_comments(parent_id);
CREATE INDEX thread_comments_author ON thread_comments(author_id, id DESC);

CREATE TABLE thread_votes (
  target_type TEXT NOT NULL CHECK (target_type IN ('thread', 'comment')),
  target_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value INTEGER NOT NULL CHECK (value IN (1, -1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (target_type, target_id, user_id)
);
CREATE INDEX thread_votes_user ON thread_votes(user_id, target_type, target_id);
