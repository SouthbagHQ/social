-- Southbag Ads: paid sponsored placements in the feeds. An advertiser prepays a budget from
-- their Southbag Online Banking account (src/lib/banking.ts, same charge() as Southbag
-- Verified); every showing and every first visit per viewer is drawn down from that budget.
-- Campaigns are never deleted: they pause, or end when the budget is spent.
CREATE TABLE ad_campaigns (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('post', 'listing', 'page')),
  target_id TEXT NOT NULL,          -- post id, marketplace listing id, or user id (a page)
  budget_cents INTEGER NOT NULL CHECK (budget_cents > 0),
  spent_cents INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended', 'rejected')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX ad_campaigns_owner ON ad_campaigns(user_id, id DESC);
CREATE INDEX ad_campaigns_serving ON ad_campaigns(status, spent_cents) WHERE status = 'active';

-- One charged visit per viewer per campaign: repeat visits are free and don't move the counters.
CREATE TABLE ad_clicks (
  campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  viewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (campaign_id, viewer_id)
);
