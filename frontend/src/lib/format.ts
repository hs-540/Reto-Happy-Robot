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

export function severityTier(severity: number): 'critical' | 'degraded' | 'normal' {
  if (severity >= 70) return 'critical'
  if (severity >= 35) return 'degraded'
  return 'normal'
}
