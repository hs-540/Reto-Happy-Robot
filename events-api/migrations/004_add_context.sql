-- Anade `context` a los eventos: el prompt de entrada del hook. Es opcional,
-- las filas que ya existen quedan con NULL. No se pierde nada.
--
-- Sin indice a proposito: es texto largo y libre, no se filtra por el.

ALTER TABLE events ADD COLUMN context TEXT;
