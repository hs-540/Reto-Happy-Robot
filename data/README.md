# /data

- `scripts/` — event script (JSON) for the Madrid regional blackout.
- `history/<type>/` — synthetic incidents pre-loaded for the RAG, segmented by element type (`hospital`, `datacenter`, `substation`). They are vectorized into Chroma with `npm run rag:preload` (idempotent) from the repo root.
