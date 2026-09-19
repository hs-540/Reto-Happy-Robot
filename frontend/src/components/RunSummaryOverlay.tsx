import type { RunSummaryView } from '@swarmup/shared'
import { Icon } from './icons'

interface RunSummaryOverlayProps {
  title: string
  summary: RunSummaryView
  pending: boolean
  onRunAgain: () => void
  onDismiss: () => void
}

function fmtSeconds(ms: number | null): string {
  return ms === null ? 'n/a' : `${(ms / 1000).toFixed(1)}s`
}

function fmtInt(n: number): string {
  return n.toLocaleString('en-US')
}

export function RunSummaryOverlay({ title, summary, pending, onRunAgain, onDismiss }: RunSummaryOverlayProps) {
  const { events, incidents, llm, meanReactionMs } = summary

  return (
    <div className="launch">
      <div className="launch__card glass glass--solid">
        <span className="launch__eyebrow">
          <i aria-hidden="true" />
          Run complete
        </span>
        <h1>Run report — {title}</h1>
        <p className="launch__lede">
          The 30-minute crisis window closed. Here is what the agent coordinated while the clock was
          running.
        </p>

        <div className="report__grid">
          <div className="report__stat">
            <small>Incidents resolved</small>
            <strong>{incidents.resolved}</strong>
            <span>{incidents.open} still open</span>
          </div>
          <div className="report__stat">
            <small>Events processed</small>
            <strong>{fmtInt(events.total)}</strong>
            <span>
              {events.alarms} alarms · {events.reports} signals
            </span>
          </div>
          <div className="report__stat">
            <small>Mean reaction</small>
            <strong>{fmtSeconds(meanReactionMs)}</strong>
            <span>trigger → decision executed</span>
          </div>
          <div className="report__stat">
            <small>LLM calls</small>
            <strong>{llm.calls}</strong>
            <span>
              {fmtSeconds(llm.minLatencyMs)} / {fmtSeconds(llm.meanLatencyMs)} /{' '}
              {fmtSeconds(llm.maxLatencyMs)} min/avg/max
            </span>
          </div>
          <div className="report__stat">
            <small>Tokens consumed</small>
            <strong>{fmtInt(llm.totalTokens)}</strong>
            <span>
              {fmtInt(llm.promptTokens)} prompt · {fmtInt(llm.completionTokens)} completion
            </span>
          </div>
          <div className="report__stat">
            <small>Decisions & actions</small>
            <strong>{fmtInt(events.decisions + events.actions)}</strong>
            <span>{events.outcomes} call outcomes</span>
          </div>
        </div>

        <div className="report__actions">
          <button
            type="button"
            className="btn btn--primary btn--xl"
            onClick={onRunAgain}
            disabled={pending}
          >
            <Icon name="restart" size={15} />
            {pending ? 'Resetting…' : 'Run again'}
          </button>
          <button type="button" className="btn" onClick={onDismiss}>
            <Icon name="chevron" size={13} />
            Inspect the timeline
          </button>
        </div>
        <small className="launch__hint">
          The full report is in the feed and the backend logs ([summary] lines).
        </small>
      </div>
    </div>
  )
}
