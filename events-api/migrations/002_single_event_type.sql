-- Pasa de la tabla vieja (type / payload / status) a la nueva, que solo guarda
-- el resumen de la llamada.
--
-- CUIDADO: las filas viejas se pierden. Sus datos vivian en `payload`, que ya
-- no existe; no hay forma automatica de convertirlos en un `summary`. Revisa
-- que no haya nada que quieras conservar antes de lanzarlo.

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
