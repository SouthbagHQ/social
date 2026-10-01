-- Boards (Pinterest): people collect images ("pins") on boards. A pin points at a file that
-- already exists: one of a post's images (source_post_id + media_id), an upload, or another
-- pin's image (a repin, source_pin_id). Files are shared, never copied; see MEDIA_IN_USE.

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,                    -- up to 50 characters
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'secret')),
  cover_pin_id TEXT,                      -- chosen cover; otherwise the top pins are used
  pin_count INTEGER NOT NULL DEFAULT 0,
  follower_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL             -- bumped when pins are added, so busy boards sort first
);
CREATE INDEX boards_owner ON boards(owner_id, updated_at DESC);
CREATE INDEX boards_visibility ON boards(visibility, updated_at DESC);

-- Group boards. 'invited' until the person accepts, then 'editor' (can add pins).
CREATE TABLE board_collaborators (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'invited' CHECK (role IN ('invited', 'editor')),
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX board_collaborators_user ON board_collaborators(user_id, role);

CREATE TABLE pins (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who pinned it
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  source_post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,  -- saved from this post (kept on repins)
  source_pin_id TEXT,                     -- repinned from this pin (may since have been deleted)
  title TEXT NOT NULL DEFAULT '',         -- up to 100 characters
  note TEXT NOT NULL DEFAULT '',          -- up to 500 characters
  link TEXT,                              -- http(s) URL
  position REAL NOT NULL,                 -- higher is nearer the top of the board
  save_count INTEGER NOT NULL DEFAULT 0,  -- times repinned, for "popular"
  created_at INTEGER NOT NULL
);
CREATE INDEX pins_board ON pins(board_id, position DESC, id DESC);
CREATE INDEX pins_user ON pins(user_id, id DESC);
CREATE INDEX pins_media ON pins(media_id);
CREATE INDEX pins_source_post ON pins(source_post_id);
CREATE INDEX pins_popular ON pins(save_count DESC, id DESC);

CREATE TABLE board_follows (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX board_follows_user ON board_follows(user_id, created_at DESC);
