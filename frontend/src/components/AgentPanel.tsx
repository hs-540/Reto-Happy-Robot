import { useState } from 'react'
import type { AgentView, FeedItem } from '@reto/shared'
import { postControl } from '../api'

interface AgentPanelProps {
  agent: AgentView
  feed: FeedItem[]
  selectedElementId: string | null
  onSelectElement: (id: string) => void
  nombresElemento: Record<string, string>
  onControlOk: () => void
}

const ETIQUETA_ACCION: Record<string, string> = {
  llamada_voz: 'Llamada de voz',
  mensaje_chat: 'Mensaje',
}

function EtiquetaEstadoAccion({ estado }: { estado: string }) {
  return <span className={`badge badge--${estado}`}>{estado}</span>
}

function descripcionFeed(
  item: FeedItem,
  nombres: Record<string, string>,
): { titulo: string; detalle: string } {
  switch (item.kind) {
    case 'alarma':
      return {
        titulo: `Alarma · ${nombres[item.elementId] ?? item.elementId}`,
        detalle: `${item.metric} = ${item.value} · severidad ${item.severidad}`,
      }
    case 'decision':
      return {
        titulo: `Decisión P${item.prioridad}${item.provocaReplan ? ' · REPLAN' : ''}`,
        detalle: item.razonamiento,
      }
    case 'accion':
      return {
        titulo: `${ETIQUETA_ACCION[item.tipo] ?? item.tipo} · ${item.estado}`,
        detalle: item.mensaje,
      }
    case 'sistema':
      return { titulo: 'Sistema', detalle: item.mensaje }
  }
}

export function AgentPanel({
  agent,
  feed,
  selectedElementId,
  onSelectElement,
  nombresElemento,
  onControlOk,
}: AgentPanelProps) {
  const [pendienteId, setPendienteId] = useState<string | null>(null)
  const [errorControl, setErrorControl] = useState<string | null>(null)
  const items = [...feed].sort((a, b) => b.seq - a.seq)

  async function decidir(id: string, accion: 'confirmar' | 'rechazar') {
    setPendienteId(id)
    setErrorControl(null)
    try {
      await postControl({ accion, id })
      onControlOk()
    } catch (e) {
      setErrorControl(e instanceof Error ? e.message : 'Error de control')
    } finally {
      setPendienteId(null)
    }
  }

  return (
    <aside className="agent">
      <section className="agent__section">
        <h2 className="agent__heading">Plan actual</h2>
        {agent.planActual ? (
          <div className="plan">
            <p className="plan__objetivo">{agent.planActual.objetivo}</p>
            <ul className="plan__pasos">
              {agent.planActual.pasos.map((paso) => (
                <li
                  key={paso.id}
                  className={`plan__paso ${paso.completado ? 'is-done' : ''} ${
                    paso.elementId === selectedElementId ? 'is-selected' : ''
                  }`}
                  onClick={() => paso.elementId && onSelectElement(paso.elementId)}
                >
                  <span className="plan__check">{paso.completado ? '✓' : ''}</span>
                  {paso.descripcion}
                </li>
              ))}
            </ul>
            {agent.planActual.replanDe && (
              <span className="plan__replan">
                replanificado sobre {agent.planActual.replanDe}
              </span>
            )}
          </div>
        ) : (
          <p className="muted">Sin plan activo.</p>
        )}
      </section>

      <section className="agent__section">
        <h2 className="agent__heading">Decisiones</h2>
        <ul className="cards">
          {agent.decisiones.map((d) => (
            <li
              key={d.id}
              className={`card ${d.elementId === selectedElementId ? 'is-selected' : ''}`}
              onClick={() => onSelectElement(d.elementId)}
            >
              <div className="card__top">
                <span className="badge badge--prioridad">P{d.prioridad}</span>
                <span className="card__elemento">
                  {nombresElemento[d.elementId] ?? d.elementId}
                </span>
                {d.provocaReplan && <span className="badge badge--replan">REPLAN</span>}
              </div>
              <p className="card__razonamiento">{d.razonamiento}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="agent__section">
        <h2 className="agent__heading">Acciones</h2>
        <ul className="cards">
          {agent.acciones.map((a) => (
            <li key={a.id} className="card">
              <div className="card__top">
                <span className="card__elemento">
                  {ETIQUETA_ACCION[a.type] ?? a.type}
                </span>
                <EtiquetaEstadoAccion estado={a.status} />
              </div>
              <p className="card__razonamiento">{a.mensaje}</p>
              {a.destinatario && (
                <span className="card__destino">→ {a.destinatario}</span>
              )}
              {a.status === 'propuesta' && (
                <div className="card__decision">
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={pendienteId === a.id}
                    onClick={() => decidir(a.id, 'confirmar')}
                  >
                    Confirmar
                  </button>
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={pendienteId === a.id}
                    onClick={() => decidir(a.id, 'rechazar')}
                  >
                    Rechazar
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {errorControl && <p className="agent__error">{errorControl}</p>}
      </section>

      <section className="agent__section">
        <h2 className="agent__heading">Actividad</h2>
        <ul className="feed">
          {items.map((item) => {
            const { titulo, detalle } = descripcionFeed(item, nombresElemento)
            const elementId = 'elementId' in item ? item.elementId : null
            return (
              <li
                key={item.seq}
                className={`feed__item feed__item--${item.kind} ${
                  elementId && elementId === selectedElementId ? 'is-selected' : ''
                }`}
                onClick={() => elementId && onSelectElement(elementId)}
              >
                <span className="feed__seq">{item.seq}</span>
                <div>
                  <span className="feed__titulo">{titulo}</span>
                  <p className="feed__detalle">{detalle}</p>
                </div>
              </li>
            )
          })}
        </ul>
      </section>
    </aside>
  )
}
