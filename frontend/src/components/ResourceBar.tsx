import type { ElementView, ResourceView } from '@swarmup/shared'

interface ResourceBarProps {
  resources: ResourceView[]
  elements: ElementView[]
  elementNames: Record<string, string>
  selectedElementId: string | null
  onSelectElement: (id: string) => void
}

const STATUS_LABEL: Record<string, string> = {
  available: 'available',
  in_transit: 'in transit',
  assigned: 'assigned',
}

export function ResourceBar({
  resources,
  elements,
  elementNames,
  selectedElementId,
  onSelectElement,
}: ResourceBarProps) {
  return (
    <footer className="resources">
      <div className="resources__group">
        <span className="resources__label">Resources</span>
        {resources.map((r) => (
          <div key={r.id} className={`resource resource--${r.status}`}>
            <span className="resource__id">{r.id}</span>
            <span className="resource__status">{STATUS_LABEL[r.status] ?? r.status}</span>
            {r.assignedElementId && (
              <span className="resource__target">
                → {elementNames[r.assignedElementId] ?? r.assignedElementId}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="resources__group">
        <span className="resources__label">Sensors</span>
        {elements.map((el) => (
          <button
            key={el.id}
            type="button"
            className={`sensor sensor--${el.status} ${
              el.id === selectedElementId ? 'is-selected' : ''
            }`}
            onClick={() => onSelectElement(el.id)}
          >
            <span className="sensor__name">{elementNames[el.id] ?? el.id}</span>
            <span className="sensor__values">
              {Object.entries(el.sensors).map(([k, v]) => (
                <span key={k}>
                  {k} <b>{v}</b>
                </span>
              ))}
            </span>
          </button>
        ))}
      </div>
    </footer>
  )
}
