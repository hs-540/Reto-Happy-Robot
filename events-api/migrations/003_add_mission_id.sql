-- Add `mission_id` to events. It is optional: existing rows keep NULL and stay
-- valid. Nothing is lost.

ALTER TABLE events ADD COLUMN mission_id TEXT;

CREATE INDEX IF NOT EXISTS idx_events_mission_id ON events (mission_id);
