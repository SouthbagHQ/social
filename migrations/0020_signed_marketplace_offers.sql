-- Signed offers are proposals, not Banking transfers. Preserve all existing offers.
-- No table references marketplace_offers; retain its outgoing FKs and indexes.
CREATE TABLE marketplace_offers_signed (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
  buyer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL CHECK (amount >= -1000000000),
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);
INSERT INTO marketplace_offers_signed
  (id, listing_id, buyer_id, amount, message, status, created_at, responded_at)
SELECT id, listing_id, buyer_id, amount, message, status, created_at, responded_at
FROM marketplace_offers;
-- Abort the migration transaction if any row or value was lost/changed.
CREATE TABLE marketplace_offers_copy_guard (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO marketplace_offers_copy_guard SELECT CASE WHEN
  (SELECT COUNT(*) FROM marketplace_offers) = (SELECT COUNT(*) FROM marketplace_offers_signed)
  AND NOT EXISTS (SELECT * FROM marketplace_offers EXCEPT SELECT * FROM marketplace_offers_signed)
  AND NOT EXISTS (SELECT * FROM marketplace_offers_signed EXCEPT SELECT * FROM marketplace_offers)
  THEN 1 ELSE 0 END;
DROP TABLE marketplace_offers_copy_guard;
DROP TABLE marketplace_offers;
ALTER TABLE marketplace_offers_signed RENAME TO marketplace_offers;
CREATE INDEX marketplace_offers_listing ON marketplace_offers(listing_id, id DESC);
CREATE INDEX marketplace_offers_buyer ON marketplace_offers(buyer_id, id DESC);
