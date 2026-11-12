-- Shared albums, powered by Southbag Drive. Album rows and membership live here; the photos
-- and videos themselves live in Southbag Drive (see src/lib/drive.ts), which holds the bytes.
-- Nothing here is ever deleted: members leave albums, albums and media stay.

CREATE TABLE albums (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  media_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE album_members (
  album_id TEXT NOT NULL REFERENCES albums(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member', -- owner | member
  invited_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, user_id)
);

CREATE TABLE album_media (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES albums(id),
  uploader_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL, -- image | video
  drive_name TEXT NOT NULL, -- the flat file name in the Drive albums account
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX album_members_user ON album_members (user_id, album_id);
CREATE INDEX album_media_album ON album_media (album_id, id);
