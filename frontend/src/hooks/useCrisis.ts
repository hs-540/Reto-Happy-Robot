import { useEffect, useState } from 'react'
import type { StateView, TopologyView } from '@reto/shared'
import { getState, getTopology } from '../api'
import {
  agent as agentMock,
  feed,
  state as stateMock,
  topology as topologyMock,
} from '../data/mock'

const POLL_MS = 2000

export function useCrisis() {
  const [topology, setTopology] = useState<TopologyView>(topologyMock)
  const [state, setState] = useState<StateView>(stateMock)
  const [live, setLive] = useState(false)

  useEffect(() => {
    let activo = true
    let timer: number | undefined
    let primeraVez = true

    async function tick() {
      try {
        const s = await getState()
        if (!activo) return
        setState(s)
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
  }, [])

  return { topology, state, live, agent: agentMock, feed }
}
