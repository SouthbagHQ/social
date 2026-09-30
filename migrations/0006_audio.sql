-- Podcasts and music (src/routes/audio.ts, public/js/views/audio.js, public/js/components/player.js).
-- A show is a podcast or an artist page; tracks are its episodes or songs. Audio bytes are ordinary
-- media rows (kind 'audio'), so they live in the MEDIA chunk stores like every other file.

CREATE TABLE shows (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('podcast', 'artist')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  cover_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  category TEXT NOT NULL DEFAULT '',
  follower_count INTEGER NOT NULL DEFAULT 0,
  track_count INTEGER NOT NULL DEFAULT 0,
  last_published_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX shows_kind_new ON shows(kind, id DESC);
CREATE INDEX shows_kind_popular ON shows(kind, follower_count DESC, id DESC);
CREATE INDEX shows_owner ON shows(owner_id, id DESC);

CREATE TABLE tracks (
  id TEXT PRIMARY KEY,
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('episode', 'song')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,  -- the audio file
  cover_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,     -- NULL: use the show's cover
  duration REAL,                                                   -- seconds
  episode_number INTEGER,
  season INTEGER,
  album TEXT,
  genre TEXT,
  post_id TEXT REFERENCES posts(id) ON DELETE SET NULL,            -- the feed post made on publish
  play_count INTEGER NOT NULL DEFAULT 0,
  like_count INTEGER NOT NULL DEFAULT 0,
  published_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX tracks_show ON tracks(show_id, id DESC);
CREATE INDEX tracks_kind ON tracks(kind, id DESC);
CREATE INDEX tracks_owner ON tracks(owner_id, id DESC);
CREATE INDEX tracks_media ON tracks(media_id);

CREATE TABLE show_follows (
  show_id TEXT NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (show_id, user_id)
);
CREATE INDEX show_follows_user ON show_follows(user_id, created_at DESC);

CREATE TABLE track_likes (
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (track_id, user_id)
);
CREATE INDEX track_likes_user ON track_likes(user_id, created_at DESC);

-- One row per counted play (a listener is counted at most once per track every 30 minutes).
-- Only the last week matters ("Popular this week"); older rows are trimmed as plays come in.
CREATE TABLE track_plays (
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL DEFAULT '',  -- '' for signed-out listeners
  created_at INTEGER NOT NULL
);
CREATE INDEX track_plays_listener ON track_plays(track_id, user_id, created_at DESC);
CREATE INDEX track_plays_recent ON track_plays(created_at);

CREATE TABLE playlists (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
  track_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX playlists_owner ON playlists(owner_id, updated_at DESC);

CREATE TABLE playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX playlist_tracks_order ON playlist_tracks(playlist_id, position);
CREATE INDEX playlist_tracks_track ON playlist_tracks(track_id);

-- Where each listener got to, so podcasts resume ("Continue listening").
CREATE TABLE listen_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position_seconds REAL NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, track_id)
);
CREATE INDEX listen_progress_recent ON listen_progress(user_id, updated_at DESC);
