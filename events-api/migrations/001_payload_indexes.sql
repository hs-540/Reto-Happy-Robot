-- Anade los indices de los campos reconocidos de payload sobre una BBDD que
-- ya existe. No toca datos.
CREATE INDEX IF NOT EXISTS idx_events_origin   ON events (json_extract(payload, '$.origin'));
CREATE INDEX IF NOT EXISTS idx_events_dest     ON events (json_extract(payload, '$.dest'));
CREATE INDEX IF NOT EXISTS idx_events_price    ON events (json_extract(payload, '$.price'));
CREATE INDEX IF NOT EXISTS idx_events_quantity ON events (json_extract(payload, '$.quantity'));
