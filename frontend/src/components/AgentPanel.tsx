import { useState } from 'react'
import type { AgentView, FeedItem } from '@swarmup/shared'
import { Icon } from './icons'
import { formatTimeOfDay } from '../lib/format'

interface AgentPanelProps {
  agent: AgentView
  feed: FeedItem[]
  selectedElementId: string | null
  onSelectElement: (id: string) => void
  elementNames: Record<string, string>
  onCollapse: () => void
}

type Tab = 'stream' | 'decisions' | 'actions'

const ACTION_LABEL: Record<string, string> = {
  voice_call: 'Voice call',
  chat_message: 'Message',
}

const SOURCE_LABEL: Record<string, string> = {
  social: 'social',
  emergency_call: 'emergency call',
  press: 'press',
  field: 'field team',
  faulty_sensor: 'faulty sensor',
}

const OUTCOME_LABEL: Record<string, string> = {
  accepted: 'accepted',
  accepted_with_delay: 'accepted with delay',
  refused: 'refused',
  no_answer: 'no answer',
}

function feedIcon(item: FeedItem): string {
  switch (item.kind) {
    case 'alarm':
      return 'alarm'
    case 'report':
      return 'chat'
    case 'decision':
      return 'decision'
    case 'action':
      return 'send'
    case 'outcome':
      return 'phone'
    case 'system':
      return 'system'
  }
}

function feedTone(item: FeedItem): string {
  switch (item.kind) {
    case 'alarm':
      return 'alarm'
    case 'report':
      return 'report'
    case 'decision':
      return 'decision'
    case 'action':
      return 'action'
    case 'outcome':
      switch (item.outcome) {
        case 'accepted':
          return 'action'
        case 'accepted_with_delay':
          return 'system'
        case 'refused':
        case 'no_answer':
          return 'alarm'
      }
      break
    case 'system':
      return 'system'
  }
}

function feedTitle(item: FeedItem): string {
  switch (item.kind) {
    case 'alarm':
      return `Alarm · ${item.metric.replace(/_/g, ' ')} = ${item.value}`
    case 'report':
      return `Report · ${SOURCE_LABEL[item.source] ?? item.source}`
    case 'decision':
      return `Decision P${item.priority}${item.provokesReplan ? ' · REPLAN' : ''}`
    case 'action':
      return `${ACTION_LABEL[item.type] ?? item.type} · ${item.status}`
    case 'outcome':
      return `Call outcome · ${OUTCOME_LABEL[item.outcome] ?? item.outcome}${
        item.delayMinutes ? ` · +${item.delayMinutes} min` : ''
      }`
    case 'system':
      return 'System'
  }
}

function feedDetail(item: FeedItem, names: Record<string, string>): string {
  switch (item.kind) {
    case 'alarm':
      return `${names[item.elementId] ?? item.elementId} · severity ${item.severity}`
    case 'report':
      return item.elementId ? `${names[item.elementId] ?? item.elementId} — ${item.text}` : item.text
    case 'decision':
      return item.reasoning
    case 'action':
      return item.message
    case 'outcome':
      return item.summary
    case 'system':
      return item.message
  }
}

function EmptyState({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="empty">
      <Icon name={icon} size={22} />
      <span>{text}</span>
    </div>
  )
}

export function AgentPanel({
  agent,
  feed,
  selectedElementId,
  onSelectElement,
  elementNames,
  onCollapse,
}: AgentPanelProps) {
  const [tab, setTab] = useState<Tab>('stream')
  const [planOpen, setPlanOpen] = useState(true)
  const plan = agent.currentPlan
  const stream = [...feed].sort((a, b) => b.seq - a.seq)
  const decisions = [...agent.decisions].reverse()
  const actions = [...agent.actions].reverse()

  return (
    <aside className="agent glass panel">
      <header className="panel__head">
        <h2>Agent</h2>
        <span className="panel__head-hint">hybrid · rules + LLM</span>
        <button
          type="button"
          className="panel__collapse panel__collapse--right"
          onClick={onCollapse}
          title="Hide agent panel"
        >
          <Icon name="chevron" size={13} />
        </button>
      </header>
      <div className="panel__body">
        <section className="plan">
          <div className="plan__head">
            <h3>Current plan</h3>
            {plan?.replanOf && <span className="badge badge--replan">Replan</span>}
            <button
              type="button"
              className={`plan__toggle ${planOpen ? '' : 'is-closed'}`}
              onClick={() => setPlanOpen((o) => !o)}
              aria-expanded={planOpen}
              title={planOpen ? 'Collapse' : 'Expand'}
            >
              <Icon name="chevron" size={13} />
            </button>
          </div>
          {planOpen &&
            (plan ? (
              <>
                <p className="plan__objective">{plan.objective}</p>
                <ul className="plan__steps">
                  {plan.steps.map((step) => (
                    <li
                      key={step.id}
                      className={`plan__step ${step.completed ? 'is-done' : ''} ${
                        step.elementId && step.elementId === selectedElementId ? 'is-selected' : ''
                      }`}
                      onClick={() => step.elementId && onSelectElement(step.elementId)}
                    >
                      <span className="plan__check">
                        <Icon name="check" size={9} />
                      </span>
                      {step.description}
                    </li>
                  ))}
                </ul>
                {plan.replanOf && <span className="plan__replan">re-planned from {plan.replanOf}</span>}
              </>
            ) : (
              <p className="muted">No active plan yet — the agent is waiting for the first alarms.</p>
            ))}
        </section>

        <nav className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'stream'}
            className={`tab ${tab === 'stream' ? 'is-active' : ''}`}
            onClick={() => setTab('stream')}
          >
            Events
            {stream.length > 0 && <span className="tab__count">{stream.length}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'decisions'}
            className={`tab ${tab === 'decisions' ? 'is-active' : ''}`}
            onClick={() => setTab('decisions')}
          >
            Decisions
            {decisions.length > 0 && <span className="tab__count">{decisions.length}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'actions'}
            className={`tab ${tab === 'actions' ? 'is-active' : ''}`}
            onClick={() => setTab('actions')}
          >
            Actions
            {actions.length > 0 && <span className="tab__count">{actions.length}</span>}
          </button>
        </nav>

        {tab === 'stream' &&
          (stream.length === 0 ? (
            <EmptyState icon="system" text="No activity yet — launch the simulation to see the agent react." />
          ) : (
            <ul className="stream">
              {stream.map((item) => {
                const elementId = 'elementId' in item ? item.elementId : null
                return (
                  <li
                    key={item.seq}
                    className={`sitem sitem--${feedTone(item)} ${
                      elementId && elementId === selectedElementId ? 'is-selected' : ''
                    }`}
                    onClick={() => elementId && onSelectElement(elementId)}
                  >
                    <span className="sitem__icon">
                      <Icon name={feedIcon(item)} size={13} />
                    </span>
                    <div className="sitem__body">
                      <div className="sitem__top">
                        <span className="sitem__title">{feedTitle(item)}</span>
                        <time>{formatTimeOfDay(item.ts)}</time>
                      </div>
                      <p>{feedDetail(item, elementNames)}</p>
                    </div>
                  </li>
                )
              })}
            </ul>
          ))}

        {tab === 'decisions' &&
          (decisions.length === 0 ? (
            <EmptyState icon="decision" text="No decisions yet — they appear when the LLM deliberates." />
          ) : (
            <ul className="cards">
              {decisions.map((d) => (
                <li
                  key={d.id}
                  className={`card ${d.elementId === selectedElementId ? 'is-selected' : ''}`}
                  onClick={() => onSelectElement(d.elementId)}
                >
                  <div className="card__top">
                    <span className="badge badge--priority">P{d.priority}</span>
                    <span className="card__element">{elementNames[d.elementId] ?? d.elementId}</span>
                    {d.provokesReplan && <span className="badge badge--replan">Replan</span>}
                    <time className="card__time">{formatTimeOfDay(d.timestamp)}</time>
                  </div>
                  <p className="card__reasoning">{d.reasoning}</p>
                </li>
              ))}
            </ul>
          ))}

        {tab === 'actions' &&
          (actions.length === 0 ? (
            <EmptyState icon="send" text="No actions yet — the agent will contact stakeholders here." />
          ) : (
            <ul className="cards">
              {actions.map((a) => (
                <li key={a.id} className="card">
                  <div className="card__top">
                    <span className="card__element">{ACTION_LABEL[a.type] ?? a.type}</span>
                    <span className="badge badge--executed">{a.status}</span>
                    <time className="card__time">{formatTimeOfDay(a.timestamp)}</time>
                  </div>
                  <p className="card__reasoning">{a.message}</p>
                  {a.recipient && <span className="card__target">→ {a.recipient}</span>}
                </li>
              ))}
            </ul>
          ))}
      </div>
    </aside>
  )
}
