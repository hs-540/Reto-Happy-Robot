import { useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import type {
  AgentView,
  ChatView,
  DirectiveKind,
  FeedItem,
  OperatorDirective,
} from '@swarmup/shared'
import { Icon } from './icons'
import { formatTimeOfDay } from '../lib/format'

interface AgentPanelProps {
  agent: AgentView
  feed: FeedItem[]
  selectedElementId: string | null
  onSelectElement: (id: string) => void
  elementNames: Record<string, string>
  onCollapse: () => void
  chat: ChatView
  /** resolves when the turn has been accepted, rejects with the reason it was not */
  onSend: (text: string) => Promise<void>
  /** the channel only makes sense over a running crisis */
  canChat: boolean
}

type Tab = 'stream' | 'decisions' | 'actions' | 'chat'

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

const DIRECTIVE_VERB: Record<DirectiveKind, string> = {
  prioritize: 'Prioritize',
  deprioritize: 'Deprioritize',
  assign: 'Send',
  release: 'Release',
  note: 'Note',
}

const DIRECTIVE_ICON: Record<DirectiveKind, string> = {
  prioritize: 'alarm',
  deprioritize: 'check',
  assign: 'send',
  release: 'check',
  note: 'chat',
}

/** What the operator ordered, in the panel's own vocabulary of sites and units */
function directiveLabel(d: OperatorDirective, names: Record<string, string>): string {
  const site = d.elementId ? names[d.elementId] ?? d.elementId : null
  switch (d.kind) {
    case 'assign':
      return `Send ${d.resourceId ?? 'unit'} → ${site ?? 'site'}`
    case 'release':
      return `Release ${d.resourceId ?? 'unit'}`
    default:
      return site ? `${DIRECTIVE_VERB[d.kind]} ${site}` : DIRECTIVE_VERB[d.kind]
  }
}

function feedIcon(item: FeedItem): string {
  switch (item.kind) {
    case 'chat':
      return 'chat'
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
    case 'chat':
      return 'operator'
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
    case 'chat':
      return item.author === 'operator' ? 'Operator → agent' : 'Agent → operator'
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
    case 'chat':
      return item.text
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

/** Structured key/value rows shown when a feed entry is expanded */
function feedDetails(
  item: FeedItem,
  names: Record<string, string>,
): Array<{ label: string; value: string }> {
  switch (item.kind) {
    case 'chat':
      return [
        { label: 'Channel', value: 'operator chat' },
        { label: 'From', value: item.author === 'operator' ? 'operator' : 'agent' },
        { label: 'Site', value: item.elementId ? names[item.elementId] ?? item.elementId : '—' },
        { label: 'Message', value: item.text },
      ]
    case 'alarm':
      return [
        { label: 'Site', value: names[item.elementId] ?? item.elementId },
        { label: 'Metric', value: item.metric.replace(/_/g, ' ') },
        { label: 'Value', value: String(item.value) },
        { label: 'Severity', value: String(item.severity) },
      ]
    case 'report':
      return [
        { label: 'Source', value: SOURCE_LABEL[item.source] ?? item.source },
        { label: 'Site', value: item.elementId ? names[item.elementId] ?? item.elementId : '—' },
        { label: 'Message', value: item.text },
      ]
    case 'decision':
      return [
        { label: 'Decision', value: item.decisionId },
        { label: 'Priority', value: `P${item.priority}` },
        { label: 'Replan', value: item.provokesReplan ? 'yes' : 'no' },
        { label: 'Reasoning', value: item.reasoning },
      ]
    case 'action':
      return [
        { label: 'Action', value: item.actionId },
        { label: 'Type', value: ACTION_LABEL[item.type] ?? item.type },
        { label: 'Status', value: item.status },
        { label: 'Message', value: item.message },
      ]
    case 'outcome': {
      const rows = [
        { label: 'Action', value: item.actionId },
        { label: 'Outcome', value: OUTCOME_LABEL[item.outcome] ?? item.outcome },
        { label: 'Summary', value: item.summary },
      ]
      if (item.delayMinutes !== null) {
        rows.splice(2, 0, { label: 'Delay', value: `+${item.delayMinutes} min` })
      }
      return rows
    }
    case 'system':
      return [{ label: 'Message', value: item.message }]
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

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail__row">
      <span className="detail__label">{label}</span>
      <span className="detail__value">{children}</span>
    </div>
  )
}

function LocateButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="detail__locate"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <Icon name="pin" size={11} />
      Show on map
    </button>
  )
}

function etaLabel(seconds: number | null): string {
  if (seconds === null) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}m${String(s).padStart(2, '0')}s`
}

export function AgentPanel({
  agent,
  feed,
  selectedElementId,
  onSelectElement,
  elementNames,
  onCollapse,
  chat,
  onSend,
  canChat,
}: AgentPanelProps) {
  const [tab, setTab] = useState<Tab>('stream')
  const [planOpen, setPlanOpen] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [chatError, setChatError] = useState<string | null>(null)
  const logRef = useRef<HTMLUListElement>(null)
  const plan = agent.currentPlan
  const stream = [...feed].sort((a, b) => b.seq - a.seq)
  const decisions = agent.decisions
  const actions = [...agent.actions].reverse()
  const blocked = !canChat || chat.thinking || sending

  // the newest turn is the one being read: follow it, like any console
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [chat.messages.length, chat.thinking, tab])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (text === '' || blocked) return
    setSending(true)
    setChatError(null)
    try {
      await onSend(text)
      setDraft('')
    } catch (err: unknown) {
      setChatError(err instanceof Error ? err.message : 'the message could not be sent')
    } finally {
      setSending(false)
    }
  }

  function onComposerKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter breaks the line: an order is usually one line
    if (e.key === 'Enter' && !e.shiftKey) void submit(e)
  }

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

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
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'chat'}
            className={`tab ${tab === 'chat' ? 'is-active' : ''}`}
            onClick={() => setTab('chat')}
          >
            Chat
            {chat.standing.length > 0 && <span className="tab__count">{chat.standing.length}</span>}
          </button>
        </nav>

        {tab === 'chat' && (
          <div className="chat">
            {chat.standing.length > 0 && (
              <div className="chat__standing">
                <span className="chat__standing-label">Standing orders</span>
                <div className="chat__chips">
                  {chat.standing.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      className="chip"
                      title={d.note}
                      onClick={() => d.elementId && onSelectElement(d.elementId)}
                    >
                      <Icon name={DIRECTIVE_ICON[d.kind]} size={10} />
                      {directiveLabel(d, elementNames)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <ul className="chat__log" ref={logRef}>
              {chat.messages.length === 0 && (
                <li className="chat__hint">
                  <EmptyState
                    icon="chat"
                    text="Talk to the agent: “prioritize the hospital on Calle de Atocha”, “send generator-2 to sub-01”, “why is crew-1 there?”. Orders face the same rules the agent's own decisions do."
                  />
                </li>
              )}
              {chat.messages.map((m) => (
                <li key={m.id} className={`bubble bubble--${m.author}`}>
                  <div className="bubble__top">
                    <span className="bubble__who">{m.author === 'operator' ? 'You' : 'Agent'}</span>
                    <time>{formatTimeOfDay(m.ts)}</time>
                  </div>
                  <p className="bubble__text">{m.text}</p>
                  {m.directives.length > 0 && (
                    <div className="chat__chips">
                      {m.directives.map((d) => (
                        <button
                          key={d.id}
                          type="button"
                          className={`chip ${d.accepted ? 'is-accepted' : 'is-refused'}`}
                          title={d.accepted ? d.note : (d.reason ?? 'refused')}
                          onClick={() => d.elementId && onSelectElement(d.elementId)}
                        >
                          <Icon name={d.accepted ? 'check' : 'alarm'} size={10} />
                          {directiveLabel(d, elementNames)}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              ))}
              {chat.thinking && (
                <li className="bubble bubble--agent is-thinking">
                  <span className="bubble__text muted">thinking…</span>
                </li>
              )}
            </ul>

            <form className="chat__composer" onSubmit={submit}>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKey}
                maxLength={800}
                rows={2}
                placeholder={
                  canChat
                    ? 'Change a priority, send a unit, or ask why…'
                    : 'Start the simulation to talk to the agent'
                }
                disabled={!canChat}
              />
              <button type="submit" disabled={blocked || draft.trim() === ''} title="Send">
                <Icon name="send" size={13} />
              </button>
            </form>
            {chatError && <p className="chat__error">{chatError}</p>}
          </div>
        )}

        {tab === 'stream' &&
          (stream.length === 0 ? (
            <EmptyState icon="system" text="No activity yet — launch the simulation to see the agent react." />
          ) : (
            <ul className="stream">
              {stream.map((item) => {
                const elementId = 'elementId' in item ? item.elementId : null
                const key = `event:${item.seq}`
                const isOpen = expanded.has(key)
                return (
                  <li
                    key={item.seq}
                    className={`sitem sitem--${feedTone(item)} ${isOpen ? 'is-open' : ''} ${
                      elementId && elementId === selectedElementId ? 'is-selected' : ''
                    }`}
                    onClick={() => toggle(key)}
                  >
                    <span className="sitem__icon">
                      <Icon name={feedIcon(item)} size={13} />
                    </span>
                    <div className="sitem__body">
                      <div className="sitem__top">
                        <span className="sitem__title">{feedTitle(item)}</span>
                        <time>{formatTimeOfDay(item.ts)}</time>
                        <span className={`sitem__chev ${isOpen ? 'is-open' : ''}`}>
                          <Icon name="chevron" size={12} />
                        </span>
                      </div>
                      {isOpen ? (
                        <div className="detail">
                          {feedDetails(item, elementNames).map((d) => (
                            <DetailRow key={d.label} label={d.label}>
                              {d.value}
                            </DetailRow>
                          ))}
                          {elementId && (
                            <LocateButton onClick={() => onSelectElement(elementId)} />
                          )}
                        </div>
                      ) : (
                        <p>{feedDetail(item, elementNames)}</p>
                      )}
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
              {decisions.map((d) => {
                const key = `decision:${d.id}`
                const isOpen = expanded.has(key)
                return (
                  <li
                    key={d.id}
                    className={`card ${isOpen ? 'is-open' : ''} ${
                      d.elementId === selectedElementId ? 'is-selected' : ''
                    }`}
                    onClick={() => toggle(key)}
                  >
                    <div className="card__top">
                      <span className="badge badge--priority">P{d.priority}</span>
                      <span className="card__element">{elementNames[d.elementId] ?? d.elementId}</span>
                      {d.provokesReplan && <span className="badge badge--replan">Replan</span>}
                      <time className="card__time">{formatTimeOfDay(d.timestamp)}</time>
                      <span className={`card__chev ${isOpen ? 'is-open' : ''}`}>
                        <Icon name="chevron" size={13} />
                      </span>
                    </div>
                    <p className={`card__reasoning ${isOpen ? '' : 'is-clamped'}`}>{d.reasoning}</p>
                    {isOpen && (
                      <div className="detail">
                        <DetailRow label="Decision">{d.id}</DetailRow>
                        <DetailRow label="Replan">{d.provokesReplan ? 'yes' : 'no'}</DetailRow>
                        <DetailRow label="Assignments">
                          {d.assignments.length === 0 ? (
                            <span className="muted">none</span>
                          ) : (
                            d.assignments.map((a) => (
                              <span
                                key={a.resourceId}
                                className={`detail__line ${a.ok ? '' : 'is-failed'}`}
                              >
                                {a.ok
                                  ? `→ ${a.resourceId} to ${
                                      elementNames[a.elementId] ?? a.elementId
                                    } · arrives in ${etaLabel(a.etaSeconds)}`
                                  : `✕ ${a.resourceId} not assigned: ${a.reason}`}
                              </span>
                            ))
                          )}
                        </DetailRow>
                        {d.actions.length > 0 && (
                          <DetailRow label="Actions">
                            {d.actions.map((a) => (
                              <span key={a.id} className="detail__line">
                                {ACTION_LABEL[a.type] ?? a.type} →{' '}
                                {a.recipient ?? elementNames[a.targetElementId] ?? a.targetElementId} ·{' '}
                                {a.status}
                              </span>
                            ))}
                          </DetailRow>
                        )}
                        <LocateButton onClick={() => onSelectElement(d.elementId)} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          ))}

        {tab === 'actions' &&
          (actions.length === 0 ? (
            <EmptyState icon="send" text="No actions yet — the agent will contact stakeholders here." />
          ) : (
            <ul className="cards">
              {actions.map((a) => {
                const key = `action:${a.id}`
                const isOpen = expanded.has(key)
                const isSelected = a.targetElementId === selectedElementId
                return (
                  <li
                    key={a.id}
                    className={`card ${isOpen ? 'is-open' : ''} ${isSelected ? 'is-selected' : ''}`}
                    onClick={() => toggle(key)}
                  >
                    <div className="card__top">
                      <span className="card__element">{ACTION_LABEL[a.type] ?? a.type}</span>
                      <span className="badge badge--executed">{a.status}</span>
                      <time className="card__time">{formatTimeOfDay(a.timestamp)}</time>
                      <span className={`card__chev ${isOpen ? 'is-open' : ''}`}>
                        <Icon name="chevron" size={13} />
                      </span>
                    </div>
                    <p className={`card__reasoning ${isOpen ? '' : 'is-clamped'}`}>{a.message}</p>
                    {isOpen && (
                      <div className="detail">
                        <DetailRow label="Action">{a.id}</DetailRow>
                        <DetailRow label="Type">{ACTION_LABEL[a.type] ?? a.type}</DetailRow>
                        <DetailRow label="Status">{a.status}</DetailRow>
                        <DetailRow label="Target">
                          {elementNames[a.targetElementId] ?? a.targetElementId}
                        </DetailRow>
                        <DetailRow label="Recipient">
                          {a.recipient ?? <span className="muted">—</span>}
                        </DetailRow>
                        <LocateButton onClick={() => onSelectElement(a.targetElementId)} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          ))}
      </div>
    </aside>
  )
}
