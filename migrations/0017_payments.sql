-- Money sent between people (src/routes/payments.ts). Southbag Online Banking moves the money; this
-- is Social's record of who paid whom and why. Each payment also appears as a message in the
-- one-to-one conversation between the two people (messages.payment_id). Payments are never deleted.
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,          -- cents the recipient received
  fees INTEGER NOT NULL DEFAULT 0,  -- cents Southbag Online Banking kept on top
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX payments_sender ON payments(sender_id, id DESC);
CREATE INDEX payments_recipient ON payments(recipient_id, id DESC);

ALTER TABLE messages ADD COLUMN payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL;
