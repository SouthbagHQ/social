-- Dating. Nobody's profile is ever shown to anyone else: the only card is a fixed one served by
-- the Worker (src/routes/dating.ts), so these tables hold nothing another user can see.

-- Created the first time someone opens Dating and presses "Get started".
CREATE TABLE dating_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  interested_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL
);

-- Pressing "Pass" removes access to Dating permanently. There is no way to remove a row.
CREATE TABLE dating_bans (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  banned_at INTEGER NOT NULL
);
