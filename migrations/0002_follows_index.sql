-- "Following" lists page by (follower_id, created_at).
CREATE INDEX IF NOT EXISTS follows_follower ON follows(follower_id, created_at DESC);
