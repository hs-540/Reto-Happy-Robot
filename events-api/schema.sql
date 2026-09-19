-- Esquema completo. Es idempotente a proposito: NO borra datos, se puede
-- lanzar contra produccion sin miedo.

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type       ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_status     ON events (status);

-- Indices sobre los campos reconocidos de payload, para que filtrar por ellos
-- no obligue a leer la tabla entera.
CREATE INDEX IF NOT EXISTS idx_events_origin   ON events (json_extract(payload, '$.origin'));
CREATE INDEX IF NOT EXISTS idx_events_dest     ON events (json_extract(payload, '$.dest'));
CREATE INDEX IF NOT EXISTS idx_events_price    ON events (json_extract(payload, '$.price'));
CREATE INDEX IF NOT EXISTS idx_events_quantity ON events (json_extract(payload, '$.quantity'));
