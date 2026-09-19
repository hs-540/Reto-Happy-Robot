/**
 * Unit identity colours, tuned to the catalog's fixed ids (crew-1..2,
 * generator-1..4, tanker-1..2, police-1..2) so a live fleet spreads across
 * the whole set instead of clustering. The hues stay OUT of the site-status
 * families — red, amber/yellow and green — and span cyan → sky → indigo →
 * violet → magenta plus a neutral slate: maximal variety inside the band the
 * sites leave free, readable on both dark and light map tiles. Collisions
 * (hash mod length) only ever pair units of different classes, whose icons
 * tell them apart.
 */
const RESOURCE_PALETTE = [
  '#818cf8', // indigo   → generator-2
  '#e879f9', // fuchsia  → generator-3
  '#a78bfa', // violet   → generator-4, police-1
  '#22d3ee', // cyan     → tanker-1, police-2
  '#38bdf8', // sky blue → tanker-2
  '#94a3b8', // slate    → crew-1
  '#d946ef', // magenta  → crew-2
  '#c084fc', // lilac    → generator-1
]

/** Deterministic color for a resource id, stable across renders and restarts */
export function resourceColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return RESOURCE_PALETTE[hash % RESOURCE_PALETTE.length]
}
