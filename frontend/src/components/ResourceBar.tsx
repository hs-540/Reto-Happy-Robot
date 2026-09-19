import type { ElementView, ResourceView } from '@swarmup/shared'

interface ResourceBarProps {
  recursos: ResourceView[]
  elementos: ElementView[]
  nombresElemento: Record<string, string>
  selectedElementId: string | null
  onSelectElement: (id: string) => void
}

const ETIQUETA_ESTADO: Record<string, string> = {
  disponible: 'disponible',
  en_transito: 'en tránsito',
  asignado: 'asignado',
}

export function ResourceBar({
  recursos,
  elementos,
  nombresElemento,
  selectedElementId,
  onSelectElement,
}: ResourceBarProps) {
  return (
    <footer className="resources">
      <div className="resources__group">
        <span className="resources__label">Recursos</span>
        {recursos.map((r) => (
          <div key={r.id} className={`resource resource--${r.status}`}>
            <span className="resource__id">{r.id}</span>
            <span className="resource__estado">{ETIQUETA_ESTADO[r.status] ?? r.status}</span>
            {r.assignedElementId && (
              <span className="resource__destino">
                → {nombresElemento[r.assignedElementId] ?? r.assignedElementId}
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="resources__group">
        <span className="resources__label">Sensores</span>
        {elementos.map((el) => (
          <button
            key={el.id}
            type="button"
            className={`sensor sensor--${el.status} ${
              el.id === selectedElementId ? 'is-selected' : ''
            }`}
            onClick={() => onSelectElement(el.id)}
          >
            <span className="sensor__nombre">{nombresElemento[el.id] ?? el.id}</span>
            <span className="sensor__valores">
              {Object.entries(el.sensores).map(([k, v]) => (
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
