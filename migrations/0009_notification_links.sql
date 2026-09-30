-- Where a notification leads when clicked, for things that aren't posts or groups
-- (events, community threads, server channels, jobs, career profiles).
ALTER TABLE notifications ADD COLUMN link TEXT;
