-- Esquema completo. Es idempotente a proposito: NO borra datos, se puede
-- lanzar contra produccion sin miedo.
--
-- Solo hay un tipo de evento, el resumen de una llamada de voz, asi que la
-- tabla no tiene ni `type` ni `payload`.

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
