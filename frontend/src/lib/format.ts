export function formatClock(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

export function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatTimeOfDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

/**
 * A repair countdown, in crisis seconds, as `m:ss`. Minutes unpadded on purpose:
 * this is read at a glance off a projected map and `4:59` lands faster than
 * `04:59`. Wall clocks elsewhere stay padded.
 */
export function formatCountdown(seconds: number): string {
  const total = Math.max(Math.round(seconds), 0)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

export function severityTier(severity: number): 'critical' | 'degraded' | 'normal' {
  if (severity >= 70) return 'critical'
  if (severity >= 35) return 'degraded'
  return 'normal'
}
