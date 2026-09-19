import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { ResourceView } from '@swarmup/shared'
import { Icon } from './icons'
import { RESOURCE_ICON } from './iconPaths'
import { resourceColor } from '../lib/palette'

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  in_transit: 'In transit',
  assigned: 'Assigned',
}

type Filter = 'all' | 'available' | 'in_transit' | 'assigned'

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'available', label: 'Available' },
  { id: 'in_transit', label: 'In transit' },
  { id: 'assigned', label: 'Assigned' },
]

interface ResourcesDockProps {
  resources: ResourceView[]
  elementNames: Record<string, string>
  selectedResourceId: string | null
  onSelectResource: (id: string | null) => void
}

/**
 * The fleet is 75-90 units: too many to lay out at once without burying the
 * map. The dock keeps a fixed height at the bottom and the units scroll inside
 * it — by status filter, by the arrows, or by dragging the track. Selecting a
 * unit anywhere else in the UI scrolls the dock to it, so the two views never
 * disagree about what is selected.
 */
export function ResourcesDock({
  resources,
  elementNames,
  selectedResourceId,
  onSelectResource,
}: ResourcesDockProps) {
  const [filter, setFilter] = useState<Filter>('all')
  const trackRef = useRef<HTMLDivElement>(null)

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { available: 0, in_transit: 0, assigned: 0 }
    for (const r of resources) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    return byStatus
  }, [resources])

  const shown = useMemo(
    () => (filter === 'all' ? resources : resources.filter((r) => r.status === filter)),
    [resources, filter],
  )

  // a unit selected on the map may sit outside the visible stretch of the track
  useEffect(() => {
    if (!selectedResourceId) return
    const node = trackRef.current?.querySelector(`[data-unit="${selectedResourceId}"]`)
    node?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [selectedResourceId, filter])

  function page(direction: 1 | -1) {
    const track = trackRef.current
    if (!track) return
    track.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: 'smooth' })
  }

  if (resources.length === 0) return null

  return (
    <footer className="dock">
      <div className="dock__head">
        <span className="dock__label">Units</span>
        <div className="dock__filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`dock__filter ${f.id === filter ? 'is-active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              <b>{f.id === 'all' ? resources.length : (counts[f.id] ?? 0)}</b>
            </button>
          ))}
        </div>
        <div className="dock__nav">
          <button
            type="button"
            className="dock__arrow dock__arrow--prev"
            onClick={() => page(-1)}
            aria-label="Previous units"
          >
            <Icon name="chevron" size={16} />
          </button>
          <button
            type="button"
            className="dock__arrow dock__arrow--next"
            onClick={() => page(1)}
            aria-label="Next units"
          >
            <Icon name="chevron" size={16} />
          </button>
        </div>
      </div>

      <div className="dock__track" ref={trackRef}>
        {shown.map((r) => (
          <button
            key={r.id}
            type="button"
            data-unit={r.id}
            className={`unit unit--${r.status} ${r.id === selectedResourceId ? 'is-selected' : ''}`}
            title={STATUS_LABEL[r.status] ?? r.status}
            style={{ '--uc': resourceColor(r.id) } as CSSProperties}
            onClick={() => onSelectResource(r.id === selectedResourceId ? null : r.id)}
          >
            <span className="unit__swatch" />
            <span className="unit__icon">
              <Icon name={RESOURCE_ICON[r.type] ?? 'generator'} size={15} />
            </span>
            <span className="unit__id">{r.id}</span>
            <span className="unit__status">{STATUS_LABEL[r.status] ?? r.status}</span>
            {r.assignedElementId && (
              <span className="unit__target">
                → {elementNames[r.assignedElementId] ?? r.assignedElementId}
              </span>
            )}
          </button>
        ))}
        {shown.length === 0 && <span className="dock__empty">No unit in this state</span>}
      </div>
    </footer>
  )
}
