-- Careers (LinkedIn): headlines, experience, education, skills and endorsements,
-- recommendations, company pages, job posts and applications.

ALTER TABLE users ADD COLUMN headline TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN open_to_work INTEGER NOT NULL DEFAULT 0;

-- ── Company pages ─────────────────────────────────────────────────────────

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  industry TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',        -- '1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5000+'
  location TEXT NOT NULL DEFAULT '',
  logo_media_id TEXT REFERENCES media(id) ON DELETE SET NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  follower_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX companies_name ON companies(name COLLATE NOCASE);

-- The owner is always an admin too. Admins edit the page and post jobs.
CREATE TABLE company_admins (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX company_admins_user ON company_admins(user_id);

CREATE TABLE company_follows (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (company_id, user_id)
);
CREATE INDEX company_follows_user ON company_follows(user_id, created_at DESC);

-- ── Career profile ────────────────────────────────────────────────────────
-- Sections are ordered by `position` (ascending), which the owner can change.

CREATE TABLE experiences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  company_name TEXT NOT NULL,
  title TEXT NOT NULL,
  employment_type TEXT NOT NULL DEFAULT 'full_time'
    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'casual', 'internship', 'self_employed', 'volunteer')),
  location TEXT NOT NULL DEFAULT '',
  start_month TEXT NOT NULL,            -- 'YYYY-MM'
  end_month TEXT,                       -- 'YYYY-MM'; NULL = current role
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX experiences_user ON experiences(user_id, position);
CREATE INDEX experiences_company_current ON experiences(company_id) WHERE end_month IS NULL;

CREATE TABLE educations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  school TEXT NOT NULL,
  degree TEXT NOT NULL DEFAULT '',
  field TEXT NOT NULL DEFAULT '',
  start_year INTEGER,
  end_year INTEGER,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX educations_user ON educations(user_id, position);

CREATE TABLE skills (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  position INTEGER NOT NULL DEFAULT 0,
  endorsement_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name)
);
CREATE INDEX skills_name ON skills(name);

CREATE TABLE endorsements (
  user_id TEXT NOT NULL,
  skill TEXT NOT NULL COLLATE NOCASE,
  endorser_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, skill, endorser_id),
  FOREIGN KEY (user_id, skill) REFERENCES skills(user_id, name) ON DELETE CASCADE
);
CREATE INDEX endorsements_endorser ON endorsements(endorser_id);

-- One recommendation per author per person. New and edited ones wait for the person's approval.
CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,     -- who it is about
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'visible', 'hidden')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, author_id)
);
CREATE INDEX recommendations_user ON recommendations(user_id, status, created_at DESC);
CREATE INDEX recommendations_author ON recommendations(author_id, created_at DESC);

-- "Please write me a recommendation." Removed once the author writes one.
CREATE TABLE recommendation_requests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,     -- who is asking
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who is asked
  message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, author_id)
);
CREATE INDEX recommendation_requests_author ON recommendation_requests(author_id, created_at DESC);

-- ── Jobs ──────────────────────────────────────────────────────────────────

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  poster_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  workplace TEXT NOT NULL DEFAULT 'onsite' CHECK (workplace IN ('onsite', 'hybrid', 'remote')),
  employment_type TEXT NOT NULL DEFAULT 'full_time'
    CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'casual', 'internship')),
  salary_min INTEGER,                   -- whole dollars a year
  salary_max INTEGER,
  currency TEXT NOT NULL DEFAULT 'AUD',
  description TEXT NOT NULL DEFAULT '',
  apply_url TEXT,                       -- set: people apply on the company's own site
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  applicant_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX jobs_open ON jobs(status, id DESC);
CREATE INDEX jobs_company ON jobs(company_id, status, id DESC);
CREATE INDEX jobs_poster ON jobs(poster_id, id DESC);

-- No résumé files: the media store only takes images, video and audio. Applicants send a note
-- and the poster reads their career profile.
CREATE TABLE job_applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'viewed', 'shortlisted', 'rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (job_id, user_id)
);
CREATE INDEX job_applications_job ON job_applications(job_id, id DESC);
CREATE INDEX job_applications_user ON job_applications(user_id, id DESC);

CREATE TABLE saved_jobs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, job_id)
);
CREATE INDEX saved_jobs_user ON saved_jobs(user_id, created_at DESC);
