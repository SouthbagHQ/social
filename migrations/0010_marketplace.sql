-- Marketplace (Facebook Marketplace / Gumtree): listings with photos, saved listings, saved searches,
-- offers, and reviews between the buyer and seller after a sale. See src/routes/marketplace.ts.
-- Prices are whole cents (AUD). 0 means free.
-- IDs are time-sortable text (see src/lib/ids.ts), so ORDER BY id DESC is newest first.

CREATE TABLE marketplace_listings (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL CHECK (price >= 0),
  negotiable INTEGER NOT NULL DEFAULT 0,
  category TEXT NOT NULL,     -- electronics, furniture, home_garden, clothing, vehicles, sport_outdoors, books, toys, other
  condition TEXT NOT NULL,    -- new, like_new, good, fair, for_parts
  location TEXT NOT NULL DEFAULT '',  -- suburb or postcode, free text
  pickup INTEGER NOT NULL DEFAULT 1,
  postage INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'pending', 'sold')),
  buyer_id TEXT REFERENCES users(id) ON DELETE SET NULL,  -- set when marked pending or sold to someone
  sold_at INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  save_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX marketplace_listings_new ON marketplace_listings(status, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX marketplace_listings_category ON marketplace_listings(category, status, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX marketplace_listings_price ON marketplace_listings(price, id) WHERE deleted_at IS NULL;
CREATE INDEX marketplace_listings_seller ON marketplace_listings(seller_id, status, id DESC);
CREATE INDEX marketplace_listings_buyer ON marketplace_listings(buyer_id);

-- 1 to 10 photos per listing, in order (position 0 is the cover).
CREATE TABLE marketplace_photos (
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (listing_id, position)
);
CREATE INDEX marketplace_photos_media ON marketplace_photos(media_id);

-- One row per listing and viewer; `day` is the last UTC day (ms / 86400000) the view was counted.
CREATE TABLE marketplace_views (
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  viewer_key TEXT NOT NULL,   -- user id, or 'anon:' + a hash of the address
  day INTEGER NOT NULL,
  PRIMARY KEY (listing_id, viewer_key)
);

CREATE TABLE marketplace_saves (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, listing_id)
);
CREATE INDEX marketplace_saves_user ON marketplace_saves(user_id, created_at DESC, listing_id DESC);
CREATE INDEX marketplace_saves_listing ON marketplace_saves(listing_id);

-- Saved searches. Empty text / NULL means "any". Checked when a listing is created.
CREATE TABLE marketplace_searches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  q TEXT NOT NULL DEFAULT '',
  category TEXT,
  condition TEXT,
  min_price INTEGER,
  max_price INTEGER,
  location TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX marketplace_searches_user ON marketplace_searches(user_id, id DESC);
CREATE INDEX marketplace_searches_category ON marketplace_searches(category, id);

CREATE TABLE marketplace_offers (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount >= 0),
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);
CREATE INDEX marketplace_offers_listing ON marketplace_offers(listing_id, id DESC);
CREATE INDEX marketplace_offers_buyer ON marketplace_offers(buyer_id, id DESC);

-- After a sale the buyer and seller may each review the other once per listing.
CREATE TABLE marketplace_reviews (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reviewee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),  -- the reviewee's part in the sale
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (listing_id, reviewer_id)
);
CREATE INDEX marketplace_reviews_reviewee ON marketplace_reviews(reviewee_id, id DESC);
