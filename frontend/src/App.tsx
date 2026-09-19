import { useState } from 'react'
import { HeaderBar } from './components/HeaderBar'
import { MapView } from './components/MapView'
import { AgentPanel } from './components/AgentPanel'
import { ResourceBar } from './components/ResourceBar'
import { useCrisis } from './hooks/useCrisis'
import './App.css'

const TICK_SEGUNDOS = 5

function App() {
  const { topology, state, agent, feed, refrescar } = useCrisis()
  const [selectedElementId, setSelectedElementId] = useState<string | null>('hosp-01')

  const nombresElemento = Object.fromEntries(
    topology.elementos.map((e) => [e.id, e.name]),
  )

  return (
    <div className="app">
      <HeaderBar
        titulo={topology.crisis.titulo}
        tick={state.tick}
        reloj={state.relojSimulacion}
        pausado={state.pausado}
        iniciado={state.iniciado}
        onControlOk={refrescar}
        segundoActual={state.tick * TICK_SEGUNDOS}
        duracionSegundos={topology.crisis.duracionSegundos}
        momentos={topology.crisis.momentos}
        ultimoSeq={state.ultimoSeq}
      />
      <MapView
        elementos={state.elementos}
        recursos={state.recursos}
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
        recursos={state.recursos}
        elementos={state.elementos}
        nombresElemento={nombresElemento}
        selectedElementId={selectedElementId}
        onSelectElement={setSelectedElementId}
      />
    </div>
  )
}

export default App
