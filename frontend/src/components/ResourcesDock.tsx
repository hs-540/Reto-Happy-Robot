import type { CSSProperties } from 'react'
import type { ResourceView } from '@swarmup/shared'
import { Icon } from './icons'
import { RESOURCE_ICON } from './iconPaths'
import { resourceColor } from '../lib/palette'

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  in_transit: 'In transit',
  assigned: 'Assigned',
}

interface ResourcesDockProps {
  resources: ResourceView[]
  elementNames: Record<string, string>
  selectedResourceId: string | null
  onSelectResource: (id: string | null) => void
}

export function ResourcesDock({
  resources,
  elementNames,
  selectedResourceId,
  onSelectResource,
}: ResourcesDockProps) {
  if (resources.length === 0) return null

  return (
    <footer className="dock">
      <span className="dock__label">Units</span>
      {resources.map((r) => (
        <button
          key={r.id}
          type="button"
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
    </footer>
  )
}
