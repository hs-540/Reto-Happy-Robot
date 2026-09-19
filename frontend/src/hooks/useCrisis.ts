import { useEffect, useRef, useState } from 'react'
import type { AgentView, FeedItem, StateView, TopologyView } from '@swarmup/shared'
import { getAgent, getFeed, getState, getTopology } from '../api'

const POLL_MS = 2000

const EMPTY_TOPOLOGY: TopologyView = {
  crisis: { title: 'Connecting to the backend…', durationSeconds: 0, moments: [] },
  elements: [],
  resources: [],
}

const EMPTY_STATE: StateView = {
  tick: 0,
  paused: false,
  started: false,
  finished: false,
  simulationClock: new Date(0).toISOString(),
  lastSeq: 0,
  elements: [],
  resources: [],
}

const EMPTY_AGENT: AgentView = {
  tick: 0,
  paused: false,
  currentPlan: null,
  decisions: [],
  actions: [],
}

export function useCrisis() {
  const [topology, setTopology] = useState<TopologyView>(EMPTY_TOPOLOGY)
  const [state, setState] = useState<StateView>(EMPTY_STATE)
  const [agent, setAgent] = useState<AgentView>(EMPTY_AGENT)
  const [feed, setFeed] = useState<FeedItem[]>([])
  const [live, setLive] = useState(false)
  const [nonce, setNonce] = useState(0)

  /** feed cursor; lives in a ref so the effect is not restarted on every poll */
  const cursor = useRef(0)
  const previousTick = useRef(0)

  useEffect(() => {
    let active = true
    let timer: number | undefined
    let firstTime = true

    async function tick() {
      try {
        const [s, a, f] = await Promise.all([
          getState(),
          getAgent(),
          getFeed(cursor.current),
        ])
        if (!active) return

        // `reset` empties the backend feed but `seq` stays monotonic:
        // the tick going backwards is the reliable signal that a new run started
        if (s.tick < previousTick.current) {
          cursor.current = 0
          setFeed([])
        }
        previousTick.current = s.tick

        setState(s)
        setAgent(a)
        if (f.items.length > 0) {
          cursor.current = f.lastSeq
          // dedup by `seq`: the accumulator tolerates a repeated poll without duplicating
          setFeed((previous) => {
            const seen = new Set(previous.map((i) => i.seq))
            return [...previous, ...f.items.filter((i) => !seen.has(i.seq))]
          })
        }
        setLive(true)

        if (firstTime) {
          firstTime = false
          getTopology()
            .then((t) => active && setTopology(t))
            .catch(() => {})
        }
      } catch {
        if (active) setLive(false)
      } finally {
        if (active) timer = window.setTimeout(tick, POLL_MS)
      }
    }

    tick()

    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [nonce])

  return {
    topology,
    state,
    agent,
    feed,
    live,
    /** immediate re-query after an operator action, without waiting for the poll */
    refresh: () => setNonce((n) => n + 1),
  }
}
