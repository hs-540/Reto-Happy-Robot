/** Distinct hues that stay readable on both dark and light map tiles */
const PALETTE = [
  '#4da3ff',
  '#ff9f43',
  '#f472b6',
  '#a78bfa',
  '#22d3ee',
  '#a3e635',
  '#fb7185',
  '#34d399',
]

/** Deterministic color for a resource id, stable across renders and restarts */
export function resourceColor(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return PALETTE[hash % PALETTE.length]
}
