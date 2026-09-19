import { useEffect, useRef, useState } from 'react'
import type {
  AgentView,
  ChatView,
  FeedItem,
  FeedSystem,
  RunSummaryView,
  StateView,
  TopologyView,
} from '@swarmup/shared'
import { getAgent, getChat, getFeed, getState, getSummary, getTopology, postChat } from '../api'

/* The map moves fast (TIME_SCALE, configurable in the backend .env):
   half-second polling keeps marker motion smooth instead of teleporting
   between jumps. Each poll also calls advance() server-side, so while the UI
   is open this — not TICK_MS — is the engine's effective cadence. */
const POLL_MS = 500

export const TICK_SECONDS = 5

/** A key moment of the script, revealed the moment its note fires on the feed */
export interface MomentMark {
  seq: number
  /** crisis second at which the moment was seen firing (poll resolution) */
  atSecond: number
  title: string
}

const EMPTY_TOPOLOGY: TopologyView = {
  crisis: { title: 'Connecting to the backend…', durationSeconds: 0 },
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

const EMPTY_CHAT: ChatView = {
  messages: [],
  standing: [],
  thinking: false,
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
  const [chat, setChat] = useState<ChatView>(EMPTY_CHAT)
  const [moments, setMoments] = useState<MomentMark[]>([])
  const [summary, setSummary] = useState<RunSummaryView | null>(null)
  const [live, setLive] = useState(false)
  const [nonce, setNonce] = useState(0)

  /** feed cursor; lives in a ref so the effect is not restarted on every poll */
  const cursor = useRef(0)
  const previousTick = useRef(0)
  /** the end-of-run report is fetched once per run, the moment the run finishes */
  const summaryLoaded = useRef(false)

  useEffect(() => {
    let active = true
    let timer: number | undefined
    let firstTime = true

    async function tick() {
      try {
        const [s, a, f, c] = await Promise.all([
          getState(),
          getAgent(),
          getFeed(cursor.current),
          getChat(),
        ])
        if (!active) return

        // `reset` empties the backend feed but `seq` stays monotonic:
        // the tick going backwards is the reliable signal that a new run started
        if (s.tick < previousTick.current) {
          cursor.current = 0
          setFeed([])
          setMoments([])
          // a reset rebuilds the backend: the new run may come with its own map
          getTopology()
            .then((t) => active && setTopology(t))
            .catch(() => {})
        }
        previousTick.current = s.tick

        setState(s)
        setAgent(a)
        setChat(c)
        // key moments enter the thread as they fire: never before
        const fired = f.items.filter(
          (i): i is FeedSystem => i.kind === 'system' && i.moment === true,
        )
        if (fired.length > 0) {
          const atSecond = s.tick * TICK_SECONDS
          setMoments((previous) => [
            ...previous,
            ...fired.map((i) => ({ seq: i.seq, atSecond, title: i.message })),
          ])
        }
        if (f.items.length > 0) {
          cursor.current = f.lastSeq
          // dedup by `seq`: the accumulator tolerates a repeated poll without duplicating
          setFeed((previous) => {
            const seen = new Set(previous.map((i) => i.seq))
            return [...previous, ...f.items.filter((i) => !seen.has(i.seq))]
          })
        }
        setLive(true)

        if (s.finished) {
          if (!summaryLoaded.current) {
            summaryLoaded.current = true
            getSummary()
              .then((r) => active && setSummary(r))
              .catch(() => {
                if (active) summaryLoaded.current = false
              })
          }
        } else if (summaryLoaded.current) {
          summaryLoaded.current = false
          setSummary(null)
        }

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
    moments,
    summary,
    chat,
    live,
    /**
     * Sends an operator turn and re-reads the channel at once, so the message
     * appears the instant it is accepted instead of on the next poll. The
     * agent's answer still arrives through the poll: it costs a model call.
     */
    sendChat: async (text: string) => {
      await postChat({ text })
      try {
        setChat(await getChat())
      } catch {
        /* the poll will catch up */
      }
    },
    /** immediate re-query after an operator action, without waiting for the poll */
    refresh: () => setNonce((n) => n + 1),
  }
}
