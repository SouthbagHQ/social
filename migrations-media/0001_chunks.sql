-- File bytes. Every MEDIA / MEDIA_n database gets this same schema.
-- A D1 row tops out at 2 MB, so files are split into chunks (see CHUNK_SIZE in src/lib/media.ts).

CREATE TABLE chunks (
  media_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (media_id, idx)
);
