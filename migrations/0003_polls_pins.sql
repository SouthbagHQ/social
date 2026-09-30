-- Polls (Twitter/Facebook style) and pinned posts (Twitter/Instagram style).

-- A poll belongs to a text post; the post body is the question.
CREATE TABLE polls (
  post_id TEXT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
  closes_at INTEGER NOT NULL,
  multiple INTEGER NOT NULL DEFAULT 0,      -- 1 = voters may pick more than one option
  voter_count INTEGER NOT NULL DEFAULT 0    -- distinct people who voted (the "N votes" line)
);

CREATE TABLE poll_options (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES polls(post_id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  vote_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX poll_options_post ON poll_options(post_id, position);

CREATE TABLE poll_votes (
  post_id TEXT NOT NULL REFERENCES polls(post_id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, option_id, user_id)
);
CREATE INDEX poll_votes_user ON poll_votes(user_id, post_id);
CREATE INDEX poll_votes_option ON poll_votes(option_id);

-- One pinned post per profile. Cleared when the post is deleted.
ALTER TABLE users ADD COLUMN pinned_post_id TEXT;
