# /data

- `scripts/` — guion de eventos (JSON) del apagón regional de Madrid.
- `history/<tipo>/` — incidentes sintéticos pre-cargados para el RAG, segmentados por tipo de elemento (`hospital`, `datacenter`, `subestacion`). Se vectorizan en Chroma con `npm run rag:precarga` (idempotente) desde la raíz del repo.
