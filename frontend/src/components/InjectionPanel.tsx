import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ElementView, SensorMetric } from '@swarmup/shared'
import { postControl } from '../api'

interface InjectionPanelProps {
  elementos: ElementView[]
  iniciado: boolean
  onControlOk: () => void
}

const METRICAS: SensorMetric[] = [
  'temperatura',
  'carga_ups',
  'bateria_generador',
  'cobertura_red',
  'tension_red',
]

/** Modo híbrido: sólo para el presentador, se abre con la tecla i (Esc cierra) */
export function InjectionPanel({ elementos, iniciado, onControlOk }: InjectionPanelProps) {
  const [abierta, setAbierta] = useState(false)
  const [elementId, setElementId] = useState('')
  const [metric, setMetric] = useState<SensorMetric>('temperatura')
  const [valor, setValor] = useState('')
  const [severidad, setSeveridad] = useState('')
  const [pendiente, setPendiente] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  useEffect(() => {
    function manejarTecla(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setAbierta(false)
        return
      }
      if (e.key !== 'i' && e.key !== 'I') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const destino = e.target
      if (
        destino instanceof HTMLElement &&
        (destino.tagName === 'INPUT' ||
          destino.tagName === 'SELECT' ||
          destino.tagName === 'TEXTAREA' ||
          destino.isContentEditable)
      ) {
        return
      }
      setAbierta((a) => !a)
    }
    window.addEventListener('keydown', manejarTecla)
    return () => window.removeEventListener('keydown', manejarTecla)
  }, [])

  if (!abierta) return null

  function limpiarResultado() {
    setOk(false)
    setError(null)
  }

  async function manejarInyeccion(e: FormEvent) {
    e.preventDefault()
    setPendiente(true)
    limpiarResultado()
    try {
      await postControl({
        accion: 'inyectar',
        payload: {
          elementId,
          metric,
          value: Number(valor),
          severidad: Number(severidad),
        },
      })
      onControlOk()
      setOk(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error de inyección')
    } finally {
      setPendiente(false)
    }
  }

  return (
    <form className="inject" onSubmit={manejarInyeccion}>
      <span className="inject__titulo">
        Inyección manual <kbd>i</kbd>
      </span>
      <fieldset className="inject__campos" disabled={!iniciado || pendiente}>
        <label className="inject__field">
          Elemento
          <select
            className="inject__control"
            value={elementId}
            onChange={(e) => {
              setElementId(e.target.value)
              limpiarResultado()
            }}
            required
          >
            <option value="" disabled>
              Elige elemento…
            </option>
            {elementos.map((el) => (
              <option key={el.id} value={el.id}>
                {el.name} ({el.id})
              </option>
            ))}
          </select>
        </label>
        <label className="inject__field">
          Métrica
          <select
            className="inject__control"
            value={metric}
            onChange={(e) => {
              const metrica = METRICAS.find((m) => m === e.target.value)
              if (metrica) {
                setMetric(metrica)
                limpiarResultado()
              }
            }}
          >
            {METRICAS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="inject__field">
          Valor
          <input
            className="inject__control"
            type="number"
            step="any"
            value={valor}
            onChange={(e) => {
              setValor(e.target.value)
              limpiarResultado()
            }}
            required
          />
        </label>
        <label className="inject__field">
          Severidad
          <input
            className="inject__control"
            type="number"
            min={0}
            max={100}
            step="1"
            value={severidad}
            onChange={(e) => {
              setSeveridad(e.target.value)
              limpiarResultado()
            }}
            required
          />
        </label>
        <button type="submit" className="btn btn--primary">
          Inyectar
        </button>
      </fieldset>
      {!iniciado && <span className="inject__hint">inicia la sim para inyectar</span>}
      {error && <span className="inject__error">{error}</span>}
      {ok && <span className="inject__ok">✓ inyectado</span>}
    </form>
  )
}
