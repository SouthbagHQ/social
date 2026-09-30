-- Events (Facebook / Meetup style). Times are epoch milliseconds; `timezone` is the IANA zone
-- the host created the event in, used for display and the calendar file.
-- privacy: public (anyone), friends (the host's friends), group (members of group_id),
--          invite (people the hosts invited). Hosts, invitees and anyone who has replied can always see it.

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,                        -- NULL: open-ended (treated as three hours for listings)
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
  location_name TEXT NOT NULL DEFAULT '',
  location_address TEXT NOT NULL DEFAULT '',
  online_url TEXT NOT NULL DEFAULT '',
  cover_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  privacy TEXT NOT NULL DEFAULT 'public' CHECK (privacy IN ('public', 'friends', 'group', 'invite')),
  capacity INTEGER,                       -- NULL: no limit on "going"
  going_count INTEGER NOT NULL DEFAULT 0,
  interested_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  cancelled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX events_starts ON events(starts_at, id);
CREATE INDEX events_host ON events(host_id, starts_at);
CREATE INDEX events_group ON events(group_id, starts_at);

-- Co-hosts (the creator is events.host_id and is not listed here).
CREATE TABLE event_hosts (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_hosts_user ON event_hosts(user_id);

CREATE TABLE event_rsvps (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('going', 'interested', 'declined')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_rsvps_event ON event_rsvps(event_id, status, created_at);
CREATE INDEX event_rsvps_user ON event_rsvps(user_id, status);

CREATE TABLE event_invites (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX event_invites_user ON event_invites(user_id);

CREATE TABLE event_comments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX event_comments_event ON event_comments(event_id, id DESC);

-- One reminder per person per event (cleared when the start time changes).
CREATE TABLE event_reminders_sent (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, user_id)
);
