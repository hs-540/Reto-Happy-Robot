import { useState } from 'react'
import type { FormEvent } from 'react'
import type { ElementView, SensorMetric } from '@swarmup/shared'
import { postControl } from '../api'
import { Icon } from './icons'

const METRICS: SensorMetric[] = [
  'temperature',
  'ups_load',
  'generator_battery',
  'network_coverage',
  'grid_voltage',
  'tower_battery',
  'fuel',
  'congestion',
]

interface InjectionModalProps {
  elements: ElementView[]
  started: boolean
  onControlOk: () => void
  onClose: () => void
}

/** Mounted only while open (App toggles it), so state starts clean every time */
export function InjectionModal({ elements, started, onControlOk, onClose }: InjectionModalProps) {
  const [elementId, setElementId] = useState('')
  const [metric, setMetric] = useState<SensorMetric>('temperature')
  const [value, setValue] = useState('')
  const [severity, setSeverity] = useState(60)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ok, setOk] = useState(false)

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
          severity,
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
    <div className="modal" role="dialog" aria-modal="true" aria-label="Manual injection" onClick={onClose}>
      <form className="modal__card glass glass--solid" onSubmit={handleInjection} onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="site__icon" style={{ '--c': 'var(--degraded)' } as React.CSSProperties}>
            <Icon name="bolt" size={15} />
          </span>
          <h2>Manual injection</h2>
          <kbd className="kbd-chip">i</kbd>
          <button type="button" className="modal__close" onClick={onClose} title="Close (Esc)">
            <Icon name="close" size={14} />
          </button>
        </div>

        <label className="field">
          <span>Site</span>
          <select
            className="control"
            value={elementId}
            onChange={(e) => {
              setElementId(e.target.value)
              clearResult()
            }}
            disabled={!started || pending}
            required
          >
            <option value="" disabled>
              Choose a site…
            </option>
            {elements.map((el) => (
              <option key={el.id} value={el.id}>
                {el.name} ({el.id})
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Sensor</span>
          <select
            className="control"
            value={metric}
            onChange={(e) => {
              const selected = METRICS.find((m) => m === e.target.value)
              if (selected) {
                setMetric(selected)
                clearResult()
              }
            }}
            disabled={!started || pending}
          >
            {METRICS.map((m) => (
              <option key={m} value={m}>
                {m.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </label>

        <div className="field__row">
          <label className="field">
            <span>Value</span>
            <input
              className="control"
              type="number"
              step="any"
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                clearResult()
              }}
              disabled={!started || pending}
              placeholder="Sensor reading"
              required
            />
          </label>
          <div className="field">
            <span>Severity</span>
            <div className="severity">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={severity}
                onChange={(e) => {
                  setSeverity(Number(e.target.value))
                  clearResult()
                }}
                disabled={!started || pending}
              />
              <output
                className="severity__value"
                style={
                  {
                    '--c':
                      severity >= 70
                        ? 'var(--critical)'
                        : severity >= 35
                          ? 'var(--degraded)'
                          : 'var(--normal)',
                  } as React.CSSProperties
                }
              >
                {severity}
              </output>
            </div>
          </div>
        </div>

        <div className="modal__foot">
          <span
            className={`modal__note ${error ? 'modal__note--error' : ''} ${ok ? 'modal__note--ok' : ''}`}
          >
            {!started
              ? 'Launch the simulation first'
              : error
                ? error
                : ok
                  ? 'Injected — the agent re-plans on the next tick'
                  : 'Crossing a threshold triggers a full re-plan'}
          </span>
          <button type="submit" className="btn btn--primary" disabled={!started || pending}>
            <Icon name="bolt" size={13} />
            Inject
          </button>
        </div>
      </form>
    </div>
  )
}
