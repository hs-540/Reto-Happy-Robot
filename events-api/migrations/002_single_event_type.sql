-- Move from the old table (type / payload / status) to the new one, which only
-- stores the call summary.
--
-- WARNING: existing rows are lost. Their data lived in `payload`, which no
-- longer exists, and there is no automatic way to turn it into a `summary`.
-- Check that nothing worth keeping is in there before running this.

DROP INDEX IF EXISTS idx_events_origin;
DROP INDEX IF EXISTS idx_events_dest;
DROP INDEX IF EXISTS idx_events_price;
DROP INDEX IF EXISTS idx_events_quantity;
DROP INDEX IF EXISTS idx_events_type;
DROP INDEX IF EXISTS idx_events_status;
DROP INDEX IF EXISTS idx_events_created_at;

DROP TABLE IF EXISTS events;

CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_events_created_at ON events (created_at DESC);
