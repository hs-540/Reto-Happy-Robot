import type { ScriptMoment } from '@swarmup/shared'
import { formatElapsed, formatClock } from '../lib/format'
import { Icon } from './icons'

interface CommandBarProps {
  title: string
  tick: number
  simClock: string
  lastSeq: number
  live: boolean
  started: boolean
  paused: boolean
  currentSecond: number
  durationSeconds: number
  moments: ScriptMoment[]
  pending: boolean
  error: string | null
  theme: 'dark' | 'light'
  onControl: (action: 'start' | 'pause' | 'resume' | 'reset') => void
  onOpenInject: () => void
  onToggleTheme: () => void
}

function statusPill(live: boolean, started: boolean, paused: boolean) {
  if (!live) return { key: 'offline', label: 'OFFLINE' }
  if (!started) return { key: 'standby', label: 'STANDBY' }
  return paused ? { key: 'paused', label: 'PAUSED' } : { key: 'live', label: 'LIVE' }
}

export function CommandBar({
  title,
  tick,
  simClock,
  lastSeq,
  live,
  started,
  paused,
  currentSecond,
  durationSeconds,
  moments,
  pending,
  error,
  theme,
  onControl,
  onOpenInject,
  onToggleTheme,
}: CommandBarProps) {
  const pill = statusPill(live, started, paused)
  const progress = durationSeconds > 0 ? Math.min(100, (currentSecond / durationSeconds) * 100) : 0
  const currentMoment = [...moments].reverse().find((m) => m.atSeconds <= currentSecond)

  return (
    <header className="command glass">
      <div className="command__row">
        <div className="command__brand">
          <span className="command__logo">
            <Icon name="logo" size={20} />
          </span>
          <div className="command__id">
            <strong>SwarmUp</strong>
            <span>{title}</span>
          </div>
          <span className={`statuspill statuspill--${pill.key}`}>
            <i aria-hidden="true" />
            {pill.label}
          </span>
        </div>

        <div className="command__stats">
          <div className="stat">
            <small>Sim clock</small>
            <span>{started ? formatClock(simClock) : '--:--:--'}</span>
          </div>
          <div className="stat">
            <small>Tick</small>
            <span>{tick}</span>
          </div>
          <div className="stat">
            <small>Events</small>
            <span>{lastSeq}</span>
          </div>
        </div>

        <div className="command__actions">
          {error && <span className="command__error">{error}</span>}
          <button
            type="button"
            className="btn btn--icon"
            onClick={onToggleTheme}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
          </button>
          <button
            type="button"
            className="btn"
            onClick={onOpenInject}
            disabled={pending}
            title="Inject a manual sensor event"
          >
            <Icon name="bolt" size={13} />
            Inject
            <kbd>i</kbd>
          </button>
          <button
            type="button"
            className="btn btn--icon btn--danger"
            onClick={() => onControl('reset')}
            disabled={pending || !started}
            title="Reset scenario"
          >
            <Icon name="restart" size={13} />
          </button>
          {!started ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => onControl('start')}
              disabled={pending}
            >
              <Icon name="play" size={12} />
              Launch
            </button>
          ) : (
            <button
              type="button"
              className={`btn ${paused ? 'btn--primary' : ''}`}
              onClick={() => onControl(paused ? 'resume' : 'pause')}
              disabled={pending}
            >
              <Icon name={paused ? 'play' : 'pause'} size={12} />
              {paused ? 'Resume' : 'Pause'}
            </button>
          )}
        </div>
      </div>

      <div className="timeline">
        <div className="timeline__moment">
          {currentMoment && started ? (
            <>
              <b>M{moments.indexOf(currentMoment) + 1}</b>
              <span>{currentMoment.title}</span>
            </>
          ) : (
            <span>{started ? 'Cruise phase' : 'Awaiting launch'}</span>
          )}
        </div>
        <div
          className="timeline__track"
          role="progressbar"
          aria-label="Simulation progress"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="timeline__fill" style={{ width: `${progress}%` }} />
          {moments.map((m, i) => (
            <div
              key={m.atSeconds}
              className={`timeline__mark ${m.atSeconds <= currentSecond && started ? 'is-past' : ''}`}
              style={{ left: `${durationSeconds > 0 ? (m.atSeconds / durationSeconds) * 100 : 0}%` }}
              title={`${formatElapsed(m.atSeconds)} · ${m.title}`}
            >
              {i + 1}
            </div>
          ))}
          <div
            className="timeline__cursor"
            style={{ left: `${progress}%`, opacity: started ? 1 : 0 }}
          />
        </div>
        <div className="timeline__clock">
          <b>{formatElapsed(currentSecond)}</b> / {formatElapsed(durationSeconds)}
        </div>
      </div>
    </header>
  )
}
