-- Southbag Verified is billed to the subscriber's Southbag Online Banking account every 30 days
-- (src/lib/banking.ts). The next charge is due at verified_renews_at; the hourly cron takes it.
ALTER TABLE users ADD COLUMN verified_renews_at INTEGER;
UPDATE users SET verified_renews_at = unixepoch() * 1000 + 30 * 86400000 WHERE verified = 1;
CREATE INDEX users_verified_renews ON users(verified_renews_at) WHERE verified = 1;
