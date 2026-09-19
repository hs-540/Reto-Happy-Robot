-- Anade `mission_id` a los eventos. Es opcional: las filas que ya existen
-- quedan con NULL y siguen siendo validas. No se pierde nada.

ALTER TABLE events ADD COLUMN mission_id TEXT;

CREATE INDEX IF NOT EXISTS idx_events_mission_id ON events (mission_id);
