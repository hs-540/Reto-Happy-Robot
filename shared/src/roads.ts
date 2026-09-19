import { z } from "zod";

/** WGS84 geographic point */
export const LatLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type LatLng = z.infer<typeof LatLngSchema>;

/**
 * Routable graph of the real street network (© OpenStreetMap contributors).
 * `nodes[i]` is a `[lat, lng]` pair; `edges` are directed pairs of node
 * indices, so oneway streets only allow travel in their real direction.
 */
export const RoadNetworkSchema = z.object({
  source: z.string().min(1),
  bbox: z.object({
    south: z.number(),
    west: z.number(),
    north: z.number(),
    east: z.number(),
  }),
  nodes: z.array(z.tuple([z.number(), z.number()])).min(2),
  edges: z
    .array(
      z.tuple([
        z.number().int().nonnegative(),
        z.number().int().nonnegative(),
      ]),
    )
    .min(1),
});
export type RoadNetwork = z.infer<typeof RoadNetworkSchema>;

export interface RoadRoute {
  /** Origin, road vertices and destination, in driving order */
  waypoints: LatLng[];
  /** Length of the whole polyline, including the access stubs */
  km: number;
}

export interface RoadRouter {
  /** Shortest path over the network, or null when none exists */
  route(from: LatLng, to: LatLng): RoadRoute | null;
}

/** Beyond this distance from any road a point is considered off the network */
const MAX_SNAP_KM = 0.5;

/** Haversine distance in km */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}

/**
 * Builds a router over the network. Snapping projects the point onto the
 * nearest road segment and Dijkstra runs from both of its endpoints, so a
 * destination in the middle of a block does not force a detour to a junction.
 * If the directed search fails (oneway walls) it retries undirected.
 */
export function createRoadRouter(network: RoadNetwork): RoadRouter {
  const { nodes, edges } = network;
  const n = nodes.length;

  /* Local flat projection around the network centroid: at municipal scale the
     error is well below a metre and it keeps snapping cheap */
  const lat0 = nodes.reduce((sum, p) => sum + p[0], 0) / n;
  const cos0 = Math.cos((lat0 * Math.PI) / 180);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (nodes[i][1] - network.bbox.west) * 111 * cos0;
    y[i] = (nodes[i][0] - lat0) * 111;
  }

  const px = (p: LatLng) => (p.lng - network.bbox.west) * 111 * cos0;
  const py = (p: LatLng) => (p.lat - lat0) * 111;

  /* Adjacency (directed) plus its undirected twin for the fallback search */
  const adj: [number, number][][] = Array.from({ length: n }, () => []);
  const undirected: [number, number][][] = Array.from({ length: n }, () => []);
  for (const [a, b] of edges) {
    const w = Math.hypot(x[a] - x[b], y[a] - y[b]);
    if (w <= 0) continue;
    adj[a].push([b, w]);
    undirected[a].push([b, w]);
    undirected[b].push([a, w]);
  }

  /** Nearest road segment to a point, with its endpoints and stub lengths */
  function snap(p: LatLng): { u: number; v: number; du: number; dv: number } | null {
    const qx = px(p);
    const qy = py(p);
    let best: { u: number; v: number; du: number; dv: number; dist: number } | null = null;
    for (const [a, b] of edges) {
      const ax = x[a];
      const ay = y[a];
      const abx = x[b] - ax;
      const aby = y[b] - ay;
      const len2 = abx * abx + aby * aby;
      if (len2 <= 0) continue;
      const t = Math.max(0, Math.min(1, ((qx - ax) * abx + (qy - ay) * aby) / len2));
      const dx = qx - (ax + t * abx);
      const dy = qy - (ay + t * aby);
      const dist = Math.hypot(dx, dy);
      if (best === null || dist < best.dist) {
        // stubs are measured straight to the endpoints: the polyline keeps
        // origin → …vertices… → destination, so cost and geometry must agree
        const du = Math.hypot(qx - ax, qy - ay);
        const dv = Math.hypot(qx - x[b], qy - y[b]);
        best = { u: a, v: b, du, dv, dist };
      }
    }
    if (best === null || best.dist > MAX_SNAP_KM) return null;
    return { u: best.u, v: best.v, du: best.du, dv: best.dv };
  }

  /** Dijkstra over `graph` from both endpoints of the snapped edge */
  function search(
    graph: [number, number][][],
    from: { u: number; v: number; du: number; dv: number },
    to: { u: number; v: number; du: number; dv: number },
  ): { km: number; path: number[] } | null {
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const done = new Uint8Array(n);
    /* binary heap of [distance, node] */
    const heap: [number, number][] = [];
    const push = (d: number, node: number): void => {
      heap.push([d, node]);
      let i = heap.length - 1;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent][0] <= heap[i][0]) break;
        [heap[parent], heap[i]] = [heap[i], heap[parent]];
        i = parent;
      }
    };
    const pop = (): [number, number] | undefined => {
      if (heap.length === 0) return undefined;
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0 && last) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const left = 2 * i + 1;
          const right = left + 1;
          let smallest = i;
          if (left < heap.length && heap[left][0] < heap[smallest][0]) smallest = left;
          if (right < heap.length && heap[right][0] < heap[smallest][0]) smallest = right;
          if (smallest === i) break;
          [heap[smallest], heap[i]] = [heap[i], heap[smallest]];
          i = smallest;
        }
      }
      return top;
    };

    dist[from.u] = from.du;
    push(from.du, from.u);
    if (from.v !== from.u) {
      dist[from.v] = Math.min(dist[from.v], from.dv);
      push(dist[from.v], from.v);
    }

    let bestEnd: number | null = null;
    let bestTotal = Infinity;
    for (;;) {
      const top = pop();
      if (!top) break;
      const [d, u] = top;
      if (d > dist[u]) continue;
      if (done[u]) continue;
      done[u] = 1;

      if (u === to.u || u === to.v) {
        const stub = u === to.u ? to.du : to.dv;
        const total = d + stub;
        if (total < bestTotal) {
          bestTotal = total;
          bestEnd = u;
        }
      }
      for (const [v, w] of graph[u]) {
        if (done[v]) continue;
        const nd = d + w;
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          push(nd, v);
        }
      }
    }

    if (bestEnd === null) return null;
    const path: number[] = [];
    for (let cur = bestEnd; cur !== -1; cur = prev[cur]) path.push(cur);
    path.reverse();
    return { km: bestTotal, path };
  }

  return {
    route(from: LatLng, to: LatLng): RoadRoute | null {
      const s = snap(from);
      const t = snap(to);
      if (s === null || t === null) return null;

      const found = search(adj, s, t) ?? search(undirected, s, t);
      if (found === null) return null;

      const waypoints: LatLng[] = [from];
      for (const idx of found.path) {
        waypoints.push({ lat: nodes[idx][0], lng: nodes[idx][1] });
      }
      waypoints.push(to);
      return { waypoints, km: found.km };
    },
  };
}
