import type { ResourceView } from '@swarmup/shared'
import { Icon } from './icons'
import { RESOURCE_ICON } from './iconPaths'

const STATUS_LABEL: Record<string, string> = {
  available: 'Available',
  in_transit: 'In transit',
  assigned: 'Assigned',
}

interface ResourcesDockProps {
  resources: ResourceView[]
  elementNames: Record<string, string>
}

export function ResourcesDock({ resources, elementNames }: ResourcesDockProps) {
  if (resources.length === 0) return null

  return (
    <footer className="dock">
      <span className="dock__label">Units</span>
      {resources.map((r) => (
        <div key={r.id} className={`unit unit--${r.status}`} title={STATUS_LABEL[r.status] ?? r.status}>
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
        </div>
      ))}
    </footer>
  )
}
