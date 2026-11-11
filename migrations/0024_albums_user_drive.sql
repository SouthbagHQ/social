-- Shared albums store media in each user's OWN Southbag Drive (Ingo's call, 2026-11-11:
-- "it should use the users tokens"). Social keeps the uploader's Identity tokens so it can
-- call Drive's API as them, and serves members the file through Drive's public share link
-- (unguessable token, never shown to the client; Social checks membership first).
-- identity_tokens holds bearer-equivalent secrets: never logged, never returned by the API.

ALTER TABLE oauth_clients ADD COLUMN scope TEXT NOT NULL DEFAULT 'openid profile email';

ALTER TABLE album_media ADD COLUMN drive_file_id TEXT;
ALTER TABLE album_media ADD COLUMN share_token TEXT;

CREATE TABLE identity_tokens (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
