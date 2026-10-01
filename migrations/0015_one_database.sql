-- One database. File bytes used to live in separate MEDIA / MEDIA_n databases ("shards");
-- they now live here, next to their metadata. Chunks in the old databases are not copied over.
-- A D1 row tops out at 2 MB, so files are split into chunks (see CHUNK_SIZE in src/lib/media.ts).

CREATE TABLE chunks (
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (media_id, idx)
);

ALTER TABLE media DROP COLUMN shard;
DROP TABLE media_shards;
