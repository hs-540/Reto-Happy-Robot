import { useEffect, useRef, useState } from 'react'
import type { AgentView, FeedItem, StateView, TopologyView } from '@swarmup/shared'
import { getAgent, getFeed, getState, getTopology } from '../api'

const POLL_MS = 2000

const TOPOLOGIA_VACIA: TopologyView = {
  crisis: { titulo: 'Conectando con el backend…', duracionSegundos: 0, momentos: [] },
  elementos: [],
  recursos: [],
}

const ESTADO_VACIO: StateView = {
  tick: 0,
  pausado: false,
  iniciado: false,
  relojSimulacion: new Date(0).toISOString(),
  ultimoSeq: 0,
  elementos: [],
  recursos: [],
}

const AGENTE_VACIO: AgentView = {
  tick: 0,
  pausado: false,
  planActual: null,
  decisiones: [],
  acciones: [],
}

export function useCrisis() {
  const [topology, setTopology] = useState<TopologyView>(TOPOLOGIA_VACIA)
  const [state, setState] = useState<StateView>(ESTADO_VACIO)
  const [agent, setAgent] = useState<AgentView>(AGENTE_VACIO)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [live, setLive] = useState(false)
  const [nonce, setNonce] = useState(0)

  /** cursor del feed; vive en un ref para no reiniciar el efecto en cada poll */
  const cursor = useRef(0)
  const tickPrevio = useRef(0)

  useEffect(() => {
    let activo = true
    let timer: number | undefined
    let primeraVez = true

    async function tick() {
      try {
        const [s, a, f] = await Promise.all([
          getState(),
          getAgent(),
          getFeed(cursor.current),
        ])
        if (!activo) return

        // `reiniciar` vacía el feed del backend pero `seq` sigue siendo monotónico:
        // el tick retrocediendo es la señal fiable de que empezó una ejecución nueva
        if (s.tick < tickPrevio.current) {
          cursor.current = 0
          setFeed([])
        }
        tickPrevio.current = s.tick

        setState(s)
        setAgent(a)
        if (f.items.length > 0) {
          cursor.current = f.ultimoSeq
          // dedup por `seq`: el acumulador tolera un poll repetido sin duplicar
          setFeed((previo) => {
            const vistos = new Set(previo.map((i) => i.seq))
            return [...previo, ...f.items.filter((i) => !vistos.has(i.seq))]
          })
        }
        setLive(true)

        if (primeraVez) {
          primeraVez = false
          getTopology()
            .then((t) => activo && setTopology(t))
            .catch(() => {})
        }
      } catch {
        if (activo) setLive(false)
      } finally {
        if (activo) timer = window.setTimeout(tick, POLL_MS)
      }
    }

    tick()

    return () => {
      activo = false
      window.clearTimeout(timer)
    }
  }, [nonce])

  return {
    topology,
    state,
    agent,
    feed,
    live,
    /** reconsulta inmediata tras una acción del operador, sin esperar el poll */
    refrescar: () => setNonce((n) => n + 1),
  }
}
