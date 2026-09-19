import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ElementView, SensorMetric } from '@swarmup/shared'
import { postControl } from '../api'

interface InjectionPanelProps {
  elements: ElementView[]
  started: boolean
  onControlOk: () => void
}

const METRICS: SensorMetric[] = [
  'temperature',
  'ups_load',
  'generator_battery',
  'network_coverage',
  'grid_voltage',
]

/** Hybrid mode: presenter only, opens with the i key (Esc closes) */
export function InjectionPanel({ elements, started, onControlOk }: InjectionPanelProps) {
  const [open, setOpen] = useState(false)
  const [elementId, setElementId] = useState('')
  const [metric, setMetric] = useState<SensorMetric>('temperature')
  const [value, setValue] = useState('')
  const [severity, setSeverity] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
      if (e.key !== 'i' && e.key !== 'I') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'SELECT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return
      }
      setOpen((o) => !o)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  if (!open) return null

  function clearResult() {
    setOk(false)
    setError(null)
  }

  async function handleInjection(e: FormEvent) {
    e.preventDefault()
    setPending(true)
    clearResult()
    try {
      await postControl({
        action: 'inject',
        payload: {
          elementId,
          metric,
          value: Number(value),
          severity: Number(severity),
        },
      })
      onControlOk()
      setOk(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Injection error')
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="inject" onSubmit={handleInjection}>
      <span className="inject__title">
        Manual injection <kbd>i</kbd>
      </span>
      <fieldset className="inject__fields" disabled={!started || pending}>
        <label className="inject__field">
          Element
          <select
            className="inject__control"
            value={elementId}
            onChange={(e) => {
              setElementId(e.target.value)
              clearResult()
            }}
            required
          >
            <option value="" disabled>
              Choose element…
            </option>
            {elements.map((el) => (
              <option key={el.id} value={el.id}>
                {el.name} ({el.id})
              </option>
            ))}
          </select>
        </label>
        <label className="inject__field">
          Metric
          <select
            className="inject__control"
            value={metric}
            onChange={(e) => {
              const selected = METRICS.find((m) => m === e.target.value)
              if (selected) {
                setMetric(selected)
                clearResult()
              }
            }}
          >
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="inject__field">
          Value
          <input
            className="inject__control"
            type="number"
            step="any"
            value={value}
            onChange={(e) => {
              setValue(e.target.value)
              clearResult()
            }}
            required
          />
        </label>
        <label className="inject__field">
          Severity
          <input
            className="inject__control"
            type="number"
            min={0}
            max={100}
            step="1"
            value={severity}
            onChange={(e) => {
              setSeverity(e.target.value)
              clearResult()
            }}
            required
          />
        </label>
        <button type="submit" className="btn btn--primary">
          Inject
        </button>
      </fieldset>
      {!started && <span className="inject__hint">start the sim to inject</span>}
      {error && <span className="inject__error">{error}</span>}
      {ok && <span className="inject__ok">✓ injected</span>}
    </form>
  )
}
