# /data

- `scripts/` — event script (JSON) for the Madrid regional blackout.
- `topology.json` — supply dependency edges between elements and resources (`supplies`, `enables_comms`, `enables_transit`, `refuels`).
- `remedies.json` — what each resource fixes, where, how long it takes and what it requires.
- `roads.json` — routable graph of the real Getafe street network (© OpenStreetMap contributors) used to move resources along actual roads: `nodes` are `[lat, lng]` pairs, `edges` are directed node pairs (oneway streets only allow their real direction). Regenerate with the Overpass API; keep the largest connected component.
- `history/<type>/` — synthetic incidents pre-loaded for the RAG, segmented by element type (`hospital`, `datacenter`, `substation`). They are vectorized into Chroma with `npm run rag:preload` (idempotent) from the repo root.
