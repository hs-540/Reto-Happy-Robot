import type { StateView, TopologyView } from '@reto/shared'

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
  return (await res.json()) as T
}

export const getTopology = () => getJson<TopologyView>('/api/topology')

export const getState = () => getJson<StateView>('/api/state')
