-- Full schema. Deliberately idempotent: it does NOT drop data, so it is safe
-- to run against production.
--
-- There is a single kind of event, the summary of a voice call, so the table
-- has neither `type` nor `payload`.

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  summary    TEXT NOT NULL,
  mission_id TEXT,
  context    TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_mission_id ON events (mission_id);
