-- Wikis (Fandom / Wikipedia style): spaces of pages with full revision history, talk pages and
-- watchlists. A space may belong to a community. Page text is wiki markup, stored in full for
-- every revision (rendered in the browser by public/js/wiki/markup.js).
-- IDs are time-sortable text (see src/lib/ids.ts), so ORDER BY id DESC is newest first.

CREATE TABLE wiki_spaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- /wiki/<slug>
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  logo_media_id TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  community_id TEXT REFERENCES communities(id) ON DELETE SET NULL,
  edit_policy TEXT NOT NULL DEFAULT 'anyone' CHECK (edit_policy IN ('anyone', 'members')),
  page_count INTEGER NOT NULL DEFAULT 0,      -- articles: pages that are not deleted and not redirects
  edit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX wiki_spaces_popular ON wiki_spaces(edit_count DESC, id DESC);
CREATE INDEX wiki_spaces_community ON wiki_spaces(community_id);

CREATE TABLE wiki_members (
  space_id TEXT NOT NULL REFERENCES wiki_spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX wiki_members_user ON wiki_members(user_id, space_id);

CREATE TABLE wiki_pages (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES wiki_spaces(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE,          -- title with spaces as underscores
  title TEXT NOT NULL,
  current_revision_id TEXT,                   -- wiki_revisions.id (no FK: the two point at each other)
  protected INTEGER NOT NULL DEFAULT 0,       -- only wiki admins may edit or move
  redirect_to TEXT COLLATE NOCASE,            -- slug, when the page is "#REDIRECT [[Target]]"
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE (space_id, slug)
);
CREATE INDEX wiki_pages_updated ON wiki_pages(space_id, updated_at DESC);

CREATE TABLE wiki_revisions (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL REFERENCES wiki_spaces(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  content TEXT NOT NULL,                      -- at most 100,000 characters
  summary TEXT NOT NULL DEFAULT '',           -- at most 200 characters
  size INTEGER NOT NULL,                      -- characters
  delta INTEGER NOT NULL DEFAULT 0,           -- size change from the previous revision
  created_at INTEGER NOT NULL
);
CREATE INDEX wiki_revisions_page ON wiki_revisions(page_id, id DESC);
CREATE INDEX wiki_revisions_space ON wiki_revisions(space_id, id DESC);
CREATE INDEX wiki_revisions_author ON wiki_revisions(author_id, id DESC);

-- Internal links in each page's current text, for "What links here".
CREATE TABLE wiki_links (
  from_page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  to_slug TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (from_page_id, to_slug)
);
CREATE INDEX wiki_links_to ON wiki_links(space_id, to_slug);

-- Images a page has ever shown ([[File:<mediaId>]]), so old revisions keep their pictures.
CREATE TABLE wiki_files (
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, media_id)
);
CREATE INDEX wiki_files_media ON wiki_files(media_id);

CREATE TABLE wiki_talk (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  parent_id TEXT REFERENCES wiki_talk(id) ON DELETE CASCADE,
  depth INTEGER NOT NULL DEFAULT 0,           -- 0 for new topics, at most 4
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX wiki_talk_page ON wiki_talk(page_id, id);

CREATE TABLE wiki_watch (
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX wiki_watch_user ON wiki_watch(user_id, created_at DESC);
