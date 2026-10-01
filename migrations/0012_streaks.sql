-- Message streaks (Snapchat style) between the two people in a one-to-one conversation.
-- One row per pair, user_a < user_b. Days are calendar days in Australia/Sydney, 'YYYY-MM-DD'.
-- A streak day counts when both people sent at least one message that day.
--   a_last_day / b_last_day  the last day user_a / user_b sent the other a message
--   last_day                 the last day both did (the last completed streak day)
--   current                  consecutive completed days ending at last_day (the cron sets it to 0
--                            once last_day is older than yesterday; readers treat it as 0 anyway)
--   warned_day               the day the "ends at midnight" notification went out
-- The row is upserted in the same batch as the message, and only when the sender's day changes,
-- so it costs at most a couple of row writes per pair per day.

CREATE TABLE streaks (
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  current INTEGER NOT NULL DEFAULT 0,
  longest INTEGER NOT NULL DEFAULT 0,
  last_day TEXT,
  a_last_day TEXT,
  b_last_day TEXT,
  started_day TEXT,
  warned_day TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
-- "My streaks" looks up both sides; the primary key covers user_a.
CREATE INDEX streaks_user_b ON streaks(user_b);
-- The hourly cron only looks at live streaks.
CREATE INDEX streaks_live ON streaks(last_day) WHERE current > 0;
