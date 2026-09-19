import type {
  AgentView,
  ChatBody,
  ChatResponse,
  ChatView,
  ControlBody,
  ControlResponse,
  FeedResponse,
  RunSummaryView,
  StateView,
  TopologyView,
} from '@swarmup/shared'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
  return (await res.json()) as T
}

export const getTopology = () => getJson<TopologyView>('/api/topology')

export const getState = () => getJson<StateView>('/api/state')

export const getAgent = () => getJson<AgentView>('/api/agent')

/** End-of-run report; meaningful once `state.finished` is true */
export const getSummary = () => getJson<RunSummaryView>('/api/summary')

/** Only what's new: the client accumulates by `seq` (CONTRACT.md, golden rule 6) */
export const getFeed = (since: number) => getJson<FeedResponse>(`/api/feed?since=${since}`)

/** The operator channel: the whole conversation, cheap enough to re-read each poll */
export const getChat = () => getJson<ChatView>('/api/chat')

/**
 * Sends a turn to the agent. The response only confirms the message was taken:
 * the answer costs a model call and arrives through the poll, like everything
 * else the agent does.
 */
export async function postChat(body: ChatBody): Promise<ChatResponse> {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as ChatResponse
  if (!res.ok || !data.ok) throw new Error(data.error ?? `POST /api/chat: ${res.status}`)
  return data
}

/** Operator action: the POST response is the feedback, it does not wait for the poll */
export async function postControl(body: ControlBody): Promise<ControlResponse> {
  const res = await fetch('/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as ControlResponse
  if (!res.ok || !data.ok) throw new Error(data.error ?? `POST /api/control: ${res.status}`)
  return data
}
