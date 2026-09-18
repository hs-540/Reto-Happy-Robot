import { useState } from 'react'
import { HeaderBar } from './components/HeaderBar'
import { MapView } from './components/MapView'
import { AgentPanel } from './components/AgentPanel'
import { ResourceBar } from './components/ResourceBar'
import {
  agent as agentData,
  feed,
  nombresElemento,
  SEGUNDO_ACTUAL,
  state,
  topology,
} from './data/mock'
import './App.css'

function App() {
  const [pausado, setPausado] = useState(state.pausado)
  const [selectedElementId, setSelectedElementId] = useState<string | null>('hosp-01')

  const agent = { ...agentData, pausado }
  const stateView = { ...state, pausado }

  return (
    <div className="app">
      <HeaderBar
        titulo={topology.crisis.titulo}
        tick={stateView.tick}
        reloj={stateView.relojSimulacion}
        pausado={pausado}
        onTogglePause={() => setPausado((p) => !p)}
        segundoActual={SEGUNDO_ACTUAL}
        duracionSegundos={topology.crisis.duracionSegundos}
        momentos={topology.crisis.momentos}
        ultimoSeq={stateView.ultimoSeq}
      />
      <MapView
        elementos={stateView.elementos}
        recursos={stateView.recursos}
        selectedElementId={selectedElementId}
        onSelectElement={setSelectedElementId}
      />
      <AgentPanel
        agent={agent}
        feed={feed}
        selectedElementId={selectedElementId}
        onSelectElement={setSelectedElementId}
        nombresElemento={nombresElemento}
      />
      <ResourceBar
        recursos={stateView.recursos}
        elementos={stateView.elementos}
        nombresElemento={nombresElemento}
        selectedElementId={selectedElementId}
        onSelectElement={setSelectedElementId}
      />
    </div>
  )
}

export default App
