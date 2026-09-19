import { useEffect, useRef, useState } from 'react'
import type { AgentView, FeedItem, StateView, TopologyView } from '@swarmup/shared'
import { getAgent, getFeed, getState, getTopology } from '../api'

const POLL_MS = 2000

const AGENTE_VACIO: AgentView = {
  tick: 0,
  pausado: false,
  planActual: null,
  decisiones: [],
  acciones: [],
}

/** CONTRACT.md regla 6: acumulador por seq (merge + dedup), nunca reemplazo */
function acumularFeed(prev: FeedItem[], nuevos: FeedItem[]): FeedItem[] {
  if (nuevos.length === 0) return prev
  const seqs = new Set(prev.map((item) => item.seq))
  const mezcla = [...prev]
  for (const item of nuevos) {
    if (!seqs.has(item.seq)) {
      seqs.add(item.seq)
      mezcla.push(item)
    }
  }
  return mezcla
}

export function useCrisis() {
  const [topology, setTopology] = useState<TopologyView | null>(null)
  const [state, setState] = useState<StateView | null>(null)
  const [agent, setAgent] = useState<AgentView>(AGENTE_VACIO)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [live, setLive] = useState(false)
  const [nonce, setNonce] = useState(0)
  const feedCursorRef = useRef(0)

  useEffect(() => {
    let activo = true
    let timer: number | undefined
    let primeraVez = true

    async function tick() {
      try {
        const s = await getState()
        const a = await getAgent()
        const f = await getFeed(feedCursorRef.current)
        if (!activo) return
        setState(s)
        setAgent(a)
        setFeed((prev) => acumularFeed(prev, f.items))
        feedCursorRef.current = Math.max(feedCursorRef.current, f.ultimoSeq)
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
    live,
    agent,
    feed,
    /** reconsulta inmediata tras una acción del operador, sin esperar el poll */
    refrescar: () => setNonce((n) => n + 1),
  }
}
