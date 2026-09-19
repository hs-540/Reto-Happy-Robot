import type { AgentView, FeedItem } from '@swarmup/shared'

interface AgentPanelProps {
  agent: AgentView
  feed: FeedItem[]
  selectedElementId: string | null
  onSelectElement: (id: string) => void
  elementNames: Record<string, string>
}

const ACTION_LABEL: Record<string, string> = {
  voice_call: 'Voice call',
  chat_message: 'Message',
}

function ActionStatusLabel({ status }: { status: string }) {
  return <span className={`badge badge--${status}`}>{status}</span>
}

function feedDescription(
  item: FeedItem,
  names: Record<string, string>,
): { title: string; detail: string } {
  switch (item.kind) {
    case 'alarm':
      return {
        title: `Alarm · ${names[item.elementId] ?? item.elementId}`,
        detail: `${item.metric} = ${item.value} · severity ${item.severity}`,
      }
    case 'decision':
      return {
        title: `Decision P${item.priority}${item.provokesReplan ? ' · REPLAN' : ''}`,
        detail: item.reasoning,
      }
    case 'action':
      return {
        title: `${ACTION_LABEL[item.type] ?? item.type} · ${item.status}`,
        detail: item.message,
      }
    case 'system':
      return { title: 'System', detail: item.message }
  }
}

export function AgentPanel({
  agent,
  feed,
  selectedElementId,
  onSelectElement,
  elementNames,
}: AgentPanelProps) {
  const items = [...feed].sort((a, b) => b.seq - a.seq)

  return (
    <aside className="agent">
      <section className="agent__section">
        <h2 className="agent__heading">Current plan</h2>
        {agent.currentPlan ? (
          <div className="plan">
            <p className="plan__objective">{agent.currentPlan.objective}</p>
            <ul className="plan__steps">
              {agent.currentPlan.steps.map((step) => (
                <li
                  key={step.id}
                  className={`plan__step ${step.completed ? 'is-done' : ''} ${
                    step.elementId === selectedElementId ? 'is-selected' : ''
                  }`}
                  onClick={() => step.elementId && onSelectElement(step.elementId)}
                >
                  <span className="plan__check">{step.completed ? '✓' : ''}</span>
                  {step.description}
                </li>
              ))}
            </ul>
            {agent.currentPlan.replanOf && (
              <span className="plan__replan">
                replanned from {agent.currentPlan.replanOf}
              </span>
            )}
          </div>
        ) : (
          <p className="muted">No active plan.</p>
        )}
      </section>

      <section className="agent__section">
        <h2 className="agent__heading">Decisions</h2>
        {agent.decisions.length === 0 ? (
          <p className="muted">No decisions yet.</p>
        ) : (
          <ul className="cards">
            {agent.decisions.map((d) => (
              <li
                key={d.id}
                className={`card ${d.elementId === selectedElementId ? 'is-selected' : ''}`}
                onClick={() => onSelectElement(d.elementId)}
              >
                <div className="card__top">
                  <span className="badge badge--priority">P{d.priority}</span>
                  <span className="card__element">
                    {elementNames[d.elementId] ?? d.elementId}
                  </span>
                  {d.provokesReplan && <span className="badge badge--replan">REPLAN</span>}
                </div>
                <p className="card__reasoning">{d.reasoning}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="agent__section">
        <h2 className="agent__heading">Actions</h2>
        {agent.actions.length === 0 ? (
          <p className="muted">No actions yet.</p>
        ) : (
          <ul className="cards">
            {agent.actions.map((a) => (
              <li key={a.id} className="card">
                <div className="card__top">
                  <span className="card__element">
                    {ACTION_LABEL[a.type] ?? a.type}
                  </span>
                  <ActionStatusLabel status={a.status} />
                </div>
                <p className="card__reasoning">{a.message}</p>
                {a.recipient && (
                  <span className="card__target">→ {a.recipient}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="agent__section">
        <h2 className="agent__heading">Activity</h2>
        {items.length === 0 ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <ul className="feed">
            {items.map((item) => {
              const { title, detail } = feedDescription(item, elementNames)
              const elementId = 'elementId' in item ? item.elementId : null
              return (
                <li
                  key={item.seq}
                  className={`feed__item feed__item--${item.kind} ${
                    elementId && elementId === selectedElementId ? 'is-selected' : ''
                  }`}
                  onClick={() => elementId && onSelectElement(elementId)}
                >
                  <span className="feed__seq">{item.seq}</span>
                  <div>
                    <span className="feed__title">{title}</span>
                    <p className="feed__detail">{detail}</p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </aside>
  )
}
