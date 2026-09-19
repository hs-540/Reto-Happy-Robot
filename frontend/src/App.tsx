import { useEffect, useState } from 'react'
import { CommandBar } from './components/CommandBar'
import { MapView } from './components/MapView'
import { SitesPanel } from './components/SitesPanel'
import { AgentPanel } from './components/AgentPanel'
import { ResourcesDock } from './components/ResourcesDock'
import { InjectionModal } from './components/InjectionModal'
import { StartOverlay } from './components/StartOverlay'
import { Icon } from './components/icons'
import { useCrisis } from './hooks/useCrisis'
import { useTheme } from './hooks/useTheme'
import { postControl } from './api'
import './App.css'

const TICK_SECONDS = 5

function Loading() {
  return (
    <div className="loading">
      <div className="loading__box">
        <span className="loading__logo">
          <Icon name="logo" size={26} />
        </span>
        <p>Connecting to the crisis engine…</p>
        <div className="loading__bar" />
      </div>
    </div>
  )
}

function App() {
  const { topology, state, agent, feed, live, refresh } = useCrisis()
  const [selectedElementId, setSelectedElementId] = useState<string | null>('hosp-01')
  const [selectedResourceId, setSelectedResourceId] = useState<string | null>(null)
  const [injectOpen, setInjectOpen] = useState(false)
  const [sitesOpen, setSitesOpen] = useState(true)
  const [agentOpen, setAgentOpen] = useState(true)
  const [theme, toggleTheme] = useTheme()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ready = state.elements.length > 0 && topology.elements.length > 0

  function selectElement(id: string | null) {
    setSelectedElementId(id)
    setSelectedResourceId(null)
  }

  function selectResource(id: string | null) {
    setSelectedResourceId(id)
    setSelectedElementId(null)
  }

  async function runControl(action: 'start' | 'pause' | 'resume' | 'reset') {
    setPending(true)
    setError(null)
    try {
      await postControl({ action })
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Control error')
    } finally {
      setPending(false)
    }
  }

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setInjectOpen(false)
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
      setInjectOpen((o) => !o)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [])

  if (!ready) {
    return <Loading />
  }

  const elementNames = Object.fromEntries(topology.elements.map((e) => [e.id, e.name]))
  const criticalityById = Object.fromEntries(topology.elements.map((e) => [e.id, e.criticality]))

  return (
    <div className="app">
      <div className="app__map">
        <MapView
          elements={state.elements}
          resources={state.resources}
          selectedElementId={selectedElementId}
          selectedResourceId={selectedResourceId}
          theme={theme}
          onSelectElement={selectElement}
          onSelectResource={selectResource}
        />
      </div>

      <div
        className={`frame ${!sitesOpen ? 'frame--sites-closed' : ''} ${
          !agentOpen ? 'frame--agent-closed' : ''
        }`}
      >
        <CommandBar
          title={topology.crisis.title}
          tick={state.tick}
          simClock={state.simulationClock}
          lastSeq={state.lastSeq}
          live={live}
          started={state.started}
          paused={state.paused}
          currentSecond={state.tick * TICK_SECONDS}
          durationSeconds={topology.crisis.durationSeconds}
          moments={topology.crisis.moments}
          pending={pending}
          error={error}
          theme={theme}
          onControl={runControl}
          onOpenInject={() => setInjectOpen(true)}
          onToggleTheme={toggleTheme}
        />

        <SitesPanel
          elements={state.elements}
          criticalityById={criticalityById}
          selectedElementId={selectedElementId}
          onSelectElement={selectElement}
          onCollapse={() => setSitesOpen(false)}
        />

        <AgentPanel
          agent={agent}
          feed={feed}
          selectedElementId={selectedElementId}
          onSelectElement={selectElement}
          elementNames={elementNames}
          onCollapse={() => setAgentOpen(false)}
        />

        <ResourcesDock
          resources={state.resources}
          elementNames={elementNames}
          selectedResourceId={selectedResourceId}
          onSelectResource={selectResource}
        />
      </div>

      {!sitesOpen && (
        <button
          type="button"
          className="reveal reveal--left"
          onClick={() => setSitesOpen(true)}
          title="Show sites panel"
        >
          <Icon name="chevron" size={13} />
          <span className="reveal__label">Sites</span>
        </button>
      )}
      {!agentOpen && (
        <button
          type="button"
          className="reveal reveal--right"
          onClick={() => setAgentOpen(true)}
          title="Show agent panel"
        >
          <Icon name="chevron" size={13} />
          <span className="reveal__label">Agent</span>
        </button>
      )}

      {!state.started && (
        <StartOverlay
          title={topology.crisis.title}
          durationSeconds={topology.crisis.durationSeconds}
          moments={topology.crisis.moments}
          sitesCount={state.elements.length}
          unitsCount={state.resources.length}
          pending={pending}
          error={error}
          onLaunch={() => runControl('start')}
        />
      )}

      {injectOpen && (
        <InjectionModal
          elements={state.elements}
          started={state.started}
          onControlOk={refresh}
          onClose={() => setInjectOpen(false)}
        />
      )}
    </div>
  )
}

export default App
