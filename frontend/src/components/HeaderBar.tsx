import { useState } from 'react'
import type { ElementView, GuionMoment } from '@swarmup/shared'
import { postControl } from '../api'
import { InjectionPanel } from './InjectionPanel'

interface HeaderBarProps {
  titulo: string
  tick: number
  reloj: string
  pausado: boolean
  iniciado: boolean
  onControlOk: () => void
  segundoActual: number
  duracionSegundos: number
  momentos: GuionMoment[]
  ultimoSeq: number
  elementos: ElementView[]
}

function formatoHora(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('es-ES', { hour12: false })
}

function formatoMinutos(segundos: number): string {
  const m = Math.floor(segundos / 60)
  const s = Math.floor(segundos % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function HeaderBar({
  titulo,
  tick,
  reloj,
  pausado,
  iniciado,
  onControlOk,
  segundoActual,
  duracionSegundos,
  momentos,
  ultimoSeq,
  elementos,
}: HeaderBarProps) {
  const [pendiente, setPendiente] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function manejarControl(accion: 'iniciar' | 'pausar' | 'reanudar') {
    setPendiente(true)
    setError(null)
    try {
      await postControl({ accion })
      onControlOk()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error de control')
    } finally {
      setPendiente(false)
    }
  }

  const enMarcha = iniciado && !pausado

  const progreso = Math.min(100, (segundoActual / duracionSegundos) * 100)
  const momentoActual = [...momentos]
    .reverse()
    .find((m) => m.atSeconds <= segundoActual)

  return (
    <header className="header">
      <div className="header__row">
        <div className="header__title">
          <span className={`dot ${enMarcha ? 'dot--live' : 'dot--paused'}`} />
          <div>
            <h1>{titulo}</h1>
            <span className="header__subtitle">
              tick {tick} · sim {formatoHora(reloj)} · seq {ultimoSeq}
            </span>
          </div>
        </div>
        <div className="header__actions">
          {momentoActual && (
            <span className="header__moment">M{momentos.indexOf(momentoActual) + 1} · {momentoActual.titulo}</span>
          )}
          {error && <span className="header__error">{error}</span>}
          {!iniciado ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => manejarControl('iniciar')}
              disabled={pendiente}
            >
              Iniciar
            </button>
          ) : (
            <button
              type="button"
              className={`btn ${pausado ? 'btn--primary' : ''}`}
              onClick={() => manejarControl(pausado ? 'reanudar' : 'pausar')}
              disabled={pendiente}
            >
              {pausado ? 'Reanudar' : 'Pausar'}
            </button>
          )}
        </div>
      </div>

      <InjectionPanel elementos={elementos} iniciado={iniciado} onControlOk={onControlOk} />

      <div className="timeline" role="presentation">
        <div className="timeline__track">
          <div className="timeline__fill" style={{ width: `${progreso}%` }} />
          {momentos.map((m, i) => (
            <div
              key={m.atSeconds}
              className={`timeline__tick ${m.atSeconds <= segundoActual ? 'is-past' : ''}`}
              style={{ left: `${(m.atSeconds / duracionSegundos) * 100}%` }}
              title={`${formatoMinutos(m.atSeconds)} · ${m.titulo}`}
            >
              <span>{i + 1}</span>
            </div>
          ))}
          <div className="timeline__cursor" style={{ left: `${progreso}%` }} />
        </div>
      </div>
    </header>
  )
}
