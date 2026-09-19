import { useState } from 'react'
import type { ElementView, ScriptMoment } from '@swarmup/shared'
import { postControl } from '../api'
import { InjectionPanel } from './InjectionPanel'

interface HeaderBarProps {
  title: string
  tick: number
  clock: string
  paused: boolean
  started: boolean
  onControlOk: () => void
  currentSecond: number
  durationSeconds: number
  moments: ScriptMoment[]
  lastSeq: number
  elements: ElementView[]
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

function formatMinutes(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function HeaderBar({
  title,
  tick,
  clock,
  paused,
  started,
  onControlOk,
  currentSecond,
  durationSeconds,
  moments,
  lastSeq,
  elements,
}: HeaderBarProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleControl(action: 'start' | 'pause' | 'resume') {
    setPending(true)
    setError(null)
    try {
      await postControl({ action })
      onControlOk()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Control error')
    } finally {
      setPending(false)
    }
  }

  const running = started && !paused

  const progress = Math.min(100, (currentSecond / durationSeconds) * 100)
  const currentMoment = [...moments]
    .reverse()
    .find((m) => m.atSeconds <= currentSecond)

  return (
    <header className="header">
      <div className="header__row">
        <div className="header__title">
          <span className={`dot ${running ? 'dot--live' : 'dot--paused'}`} />
          <div>
            <h1>{title}</h1>
            <span className="header__subtitle">
              tick {tick} · sim {formatTime(clock)} · seq {lastSeq}
            </span>
          </div>
        </div>
        <div className="header__actions">
          {currentMoment && (
            <span className="header__moment">M{moments.indexOf(currentMoment) + 1} · {currentMoment.title}</span>
          )}
          {error && <span className="header__error">{error}</span>}
          {!started ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => handleControl('start')}
              disabled={pending}
            >
              Start
            </button>
          ) : (
            <button
              type="button"
              className={`btn ${paused ? 'btn--primary' : ''}`}
              onClick={() => handleControl(paused ? 'resume' : 'pause')}
              disabled={pending}
            >
              {paused ? 'Resume' : 'Pause'}
            </button>
          )}
        </div>
      </div>

      <InjectionPanel elements={elements} started={started} onControlOk={onControlOk} />

      <div className="timeline" role="presentation">
        <div className="timeline__track">
          <div className="timeline__fill" style={{ width: `${progress}%` }} />
          {moments.map((m, i) => (
            <div
              key={m.atSeconds}
              className={`timeline__tick ${m.atSeconds <= currentSecond ? 'is-past' : ''}`}
              style={{ left: `${(m.atSeconds / durationSeconds) * 100}%` }}
              title={`${formatMinutes(m.atSeconds)} · ${m.title}`}
            >
              <span>{i + 1}</span>
            </div>
          ))}
          <div className="timeline__cursor" style={{ left: `${progress}%` }} />
        </div>
      </div>
    </header>
  )
}
