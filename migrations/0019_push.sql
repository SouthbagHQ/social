-- Push notifications (Web Push, src/lib/push.ts). One row per browser that turned notifications on.
-- A subscription belongs to the session that made it: signing out (or the session expiring) stops
-- pushes to that browser, and the hourly janitor drops subscriptions whose session is gone.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);

-- When a notification was claimed for pushing. Only notifications from the last few minutes are
-- ever pushed (found by their time-sortable id), so old rows simply stay NULL.
ALTER TABLE notifications ADD COLUMN pushed_at INTEGER;
