import type {
  AgentView,
  ControlBody,
  ControlResponse,
  FeedResponse,
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

/** Solo lo nuevo: el cliente acumula por `seq` (CONTRACT.md, regla de oro 6) */
export const getFeed = (since: number) => getJson<FeedResponse>(`/api/feed?since=${since}`)

/** Acción del operador: la respuesta del POST es el feedback, no espera al poll */
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
