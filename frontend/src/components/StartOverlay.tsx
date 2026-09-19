import { Icon } from './icons'

interface StartOverlayProps {
  title: string
  durationSeconds: number
  sitesCount: number
  unitsCount: number
  pending: boolean
  error: string | null
  onLaunch: () => void
}

export function StartOverlay({
  title,
  durationSeconds,
  sitesCount,
  unitsCount,
  pending,
  error,
  onLaunch,
}: StartOverlayProps) {
  return (
    <div className="launch">
      <div className="launch__card glass glass--solid">
        <span className="launch__eyebrow">
          <i aria-hidden="true" />
          Scenario ready
        </span>
        <h1>{title}</h1>
        <p className="launch__lede">
          An autonomous agent triages the alarms that matter, prioritizes the remaining resources on
          the ground and re-plans as the crisis unfolds. You can inject live events at any time.
        </p>

        <div className="launch__meta">
          <span>{sitesCount} sites</span>
          <span>{unitsCount} units</span>
          <span>{Math.round(durationSeconds / 60)} min</span>
        </div>

        <p className="launch__brief">
          The scenario unfolds live: the command bar reveals each moment of the crisis only once it
          has happened.
        </p>

        <button type="button" className="btn btn--primary btn--xl" onClick={onLaunch} disabled={pending}>
          <Icon name="play" size={15} />
          {pending ? 'Launching…' : 'Launch simulation'}
        </button>
        {error && <span className="launch__hint launch__hint--error">{error}</span>}
        <small className="launch__hint">
          First deliberation takes 8–30 s — alarms appear instantly while the agent thinks.
        </small>
      </div>
    </div>
  )
}
