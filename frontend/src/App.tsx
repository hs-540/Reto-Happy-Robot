import { useState } from 'react'
import { HeaderBar } from './components/HeaderBar'
import { MapView } from './components/MapView'
import { AgentPanel } from './components/AgentPanel'
import { ResourceBar } from './components/ResourceBar'
import { useCrisis } from './hooks/useCrisis'
import './App.css'

const TICK_SECONDS = 5

function App() {
  const { topology, state, agent, feed, refresh } = useCrisis()
  const [selectedElementId, setSelectedElementId] = useState<string | null>('hosp-01')

  if (!topology || !state) {
    return (
      <div className="connecting">
        <p className="muted">Connecting to the backend…</p>
      </div>
    )
  }

  const elementNames = Object.fromEntries(
    topology.elements.map((e) => [e.id, e.name]),
  )

  return (
    <div className="app">
      <HeaderBar
        title={topology.crisis.title}
        tick={state.tick}
        clock={state.simulationClock}
        paused={state.paused}
        started={state.started}
        onControlOk={refresh}
        currentSecond={state.tick * TICK_SECONDS}
        durationSeconds={topology.crisis.durationSeconds}
        moments={topology.crisis.moments}
        lastSeq={state.lastSeq}
        elements={state.elements}
      />
      <MapView
        elements={state.elements}
        resources={state.resources}
        selectedElementId={selectedElementId}
        onSelectElement={setSelectedElementId}
      />
      <AgentPanel
        agent={agent}
        feed={feed}
        selectedElementId={selectedElementId}
        onSelectElement={setSelectedElementId}
        elementNames={elementNames}
      />
      <ResourceBar
        resources={state.resources}
        elements={state.elements}
        elementNames={elementNames}
        selectedElementId={selectedElementId}
        onSelectElement={setSelectedElementId}
      />
    </div>
  )
}

export default App
