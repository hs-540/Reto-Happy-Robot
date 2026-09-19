import { useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap, Marker } from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ElementView, RepairEstimate, ResourceView } from '@swarmup/shared'
import { ICON_PATHS, ELEMENT_ICON, RESOURCE_ICON } from './iconPaths'
import { resourceColor } from '../lib/palette'
import { formatCountdown } from '../lib/format'

const TILES: Record<'dark' | 'light', string[]> = {
  dark: [
    'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
    'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
  ],
  light: [
    'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
    'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
    'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
    'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
  ],
}

interface RouteCollection {
  type: 'FeatureCollection'
  features: {
    type: 'Feature'
    properties: { color: string }
    geometry: { type: 'LineString'; coordinates: [number, number][] }
  }[]
}

const EMPTY_ROUTES: RouteCollection = { type: 'FeatureCollection', features: [] }

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: TILES.dark,
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
    routes: {
      type: 'geojson',
      data: EMPTY_ROUTES,
    },
  },
  layers: [
    { id: 'carto', type: 'raster', source: 'carto' },
    {
      id: 'route-line',
      type: 'line',
      source: 'routes',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['to-color', ['get', 'color']],
        'line-width': 2.5,
        'line-opacity': 0.9,
        'line-dasharray': [0.1, 2],
      },
    },
  ],
}

interface MarkerSpec {
  kind: 'element' | 'resource'
  variant: string
  icon: string
  label: string
}

interface MarkerEntry {
  marker: Marker
  node: HTMLButtonElement
  variant: string
  /** the repair countdown under the dot; resources do not have one */
  eta: HTMLElement | null
}

function markerClassName(spec: MarkerSpec, selected: boolean): string {
  return [
    'marker',
    `marker--${spec.kind}`,
    `marker--${spec.variant}`,
    selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

function createMarkerNode(
  spec: MarkerSpec,
  selected: boolean,
  onClick?: () => void,
): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = markerClassName(spec, selected)
  // The countdown sits UNDER the dot: the label already occupies the space to
  // its right, vertically centred, so a badge in the corner would land on the
  // site's name. Always rendered, hidden until there is something to count.
  const eta = spec.kind === 'element' ? '<span class="marker__eta" hidden></span>' : ''
  node.innerHTML = `<span class="marker__dot"><svg viewBox="0 0 24 24" aria-hidden="true">${spec.icon}</svg>${eta}</span><span class="marker__label">${spec.label}</span>`
  if (onClick) node.addEventListener('click', onClick)
  return node
}

function applyVariant(entry: MarkerEntry, variant: string) {
  if (entry.variant === variant) return
  entry.node.classList.remove(`marker--${entry.variant}`)
  entry.node.classList.add(`marker--${variant}`)
  entry.variant = variant
}

/** Clip the polyline to the part ahead of the resource's current position */
function remainingRoute(
  coords: [number, number][],
  pos: [number, number],
): [number, number][] {
  let idx = 0
  let t = 0
  let best = Infinity
  for (let i = 0; i < coords.length - 1; i++) {
    const [ax, ay] = coords[i]
    const [bx, by] = coords[i + 1]
    const vx = bx - ax
    const vy = by - ay
    const len2 = vx * vx + vy * vy
    const s =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((pos[0] - ax) * vx + (pos[1] - ay) * vy) / len2))
    const qx = ax + vx * s - pos[0]
    const qy = ay + vy * s - pos[1]
    const d = qx * qx + qy * qy
    if (d < best) {
      best = d
      idx = i
      t = s
    }
  }
  const rest = coords.slice(idx + 1)
  if (t >= 1) return rest
  const head: [number, number] = [
    coords[idx][0] + (coords[idx + 1][0] - coords[idx][0]) * t,
    coords[idx][1] + (coords[idx + 1][1] - coords[idx][1]) * t,
  ]
  return [head, ...rest]
}

/**
 * The marker's label is written once and never touched again — a site's name
 * does not change. The countdown does, every poll, so it gets its own update
 * path rather than being rebuilt into the node.
 */
function applyCountdown(entry: MarkerEntry, repair: RepairEstimate | null, elementId: string) {
  const eta = entry.eta
  if (!eta) return
  // nothing on its way, or already done: the dot's own colour says the rest
  if (!repair || repair.totalSeconds === 0) {
    eta.hidden = true
    return
  }
  const inherited = repair.viaElementId !== elementId
  eta.hidden = false
  eta.textContent = formatCountdown(repair.totalSeconds)
  eta.classList.toggle('marker__eta--inherited', inherited)
  eta.title = inherited
    ? `Fixed by the repair of ${repair.viaElementId} (${repair.resourceId})`
    : `${repair.resourceId}: ${formatCountdown(repair.travelSeconds)} travelling + ${formatCountdown(repair.workSeconds)} working`
}

interface MapViewProps {
  elements: ElementView[]
  resources: ResourceView[]
  selectedElementId: string | null
  selectedResourceId: string | null
  theme: 'dark' | 'light'
  onSelectElement: (id: string | null) => void
  onSelectResource: (id: string | null) => void
}

export function MapView({
  elements,
  resources,
  selectedElementId,
  selectedResourceId,
  theme,
  onSelectElement,
  onSelectResource,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markersRef = useRef<Map<string, MarkerEntry>>(new Map())
  const prevSelectedRef = useRef<string | null | undefined>(selectedElementId)
  const selectRef = useRef(onSelectElement)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    selectRef.current = onSelectElement
  }, [onSelectElement])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new MapLibreMap({
      container: containerRef.current,
      style: STYLE,
      center: [-3.72, 40.302],
      zoom: 13.4,
      minZoom: 10,
      maxZoom: 17,
      dragRotate: false,
      attributionControl: { compact: true },
    })
    map.on('load', () => {
      if (mapRef.current === map) setReady(true)
    })
    /** Clicking empty map clears the selection; clicks on markers are ignored here */
    map.on('click', (e) => {
      const target = e.originalEvent.target
      if (target instanceof Element && target.closest('.marker')) return
      selectRef.current(null)
    })
    mapRef.current = map
    const store = markersRef.current
    return () => {
      map.remove()
      mapRef.current = null
      store.clear()
      setReady(false)
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const store = markersRef.current
    const alive = new Set<string>()

    /** Selected resource or the target site of the selection draw their route */
    const source = map.getSource('routes')
    if (source && 'setData' in source) {
      const features = resources
        .filter(
          (r) =>
            r.route &&
            r.route.length >= 2 &&
            (r.id === selectedResourceId ||
              (r.assignedElementId !== null && r.assignedElementId === selectedElementId)),
        )
        .map((r) => ({
          type: 'Feature' as const,
          properties: { color: resourceColor(r.id) },
          geometry: {
            type: 'LineString' as const,
            coordinates: remainingRoute(
              r.route!.map((p) => [p.lng, p.lat] as [number, number]),
              [r.lng, r.lat],
            ),
          },
        }))
        .filter((f) => f.geometry.coordinates.length >= 2)
      ;(source as { setData: (data: RouteCollection) => void }).setData({
        type: 'FeatureCollection',
        features,
      })
    }

    resources.forEach((r) => {
      alive.add(r.id)
      const selected = r.id === selectedResourceId
      const entry = store.get(r.id)
      if (entry) {
        applyVariant(entry, r.status)
        entry.node.classList.toggle('is-selected', selected)
        entry.marker.setLngLat([r.lng, r.lat])
      } else {
        const node = createMarkerNode(
          {
            kind: 'resource',
            variant: r.status,
            icon: ICON_PATHS[RESOURCE_ICON[r.type] ?? 'generator'] ?? '',
            label: r.id,
          },
          selected,
          () => onSelectResource(r.id),
        )
        node.style.setProperty('--uc', resourceColor(r.id))
        store.set(r.id, {
          marker: new Marker({ element: node, anchor: 'center' })
            .setLngLat([r.lng, r.lat])
            .addTo(map),
          node,
          variant: r.status,
          eta: null,
        })
      }
    })

    elements.forEach((el) => {
      alive.add(el.id)
      const selected = el.id === selectedElementId
      const entry = store.get(el.id)
      if (entry) {
        applyVariant(entry, el.status)
        entry.node.classList.toggle('is-selected', selected)
        entry.marker.setLngLat([el.lng, el.lat])
        applyCountdown(entry, el.repair, el.id)
      } else {
        const node = createMarkerNode(
          {
            kind: 'element',
            variant: el.status,
            icon: ICON_PATHS[ELEMENT_ICON[el.type] ?? 'hospital'] ?? '',
            label: el.name,
          },
          selected,
          () => onSelectElement(el.id),
        )
        const created: MarkerEntry = {
          marker: new Marker({ element: node, anchor: 'center' })
            .setLngLat([el.lng, el.lat])
            .addTo(map),
          node,
          variant: el.status,
          eta: node.querySelector('.marker__eta'),
        }
        applyCountdown(created, el.repair, el.id)
        store.set(el.id, created)
      }
    })

    for (const [id, entry] of store) {
      if (!alive.has(id)) {
        entry.marker.remove()
        store.delete(id)
      }
    }
  }, [elements, resources, selectedElementId, selectedResourceId, onSelectElement, onSelectResource, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const source = map.getSource('carto')
    if (source && 'setTiles' in source) {
      ;(source as { setTiles: (tiles: string[]) => void }).setTiles(TILES[theme])
    }
  }, [theme, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const prev = prevSelectedRef.current
    prevSelectedRef.current = selectedElementId
    if (prev === selectedElementId || !selectedElementId) return
    const el = elements.find((e) => e.id === selectedElementId)
    if (!el) return
    map.flyTo({
      center: [el.lng, el.lat],
      zoom: Math.max(map.getZoom(), 14.2),
      duration: 800,
    })
  }, [selectedElementId, elements, ready])

  return <div className="map" ref={containerRef} />
}
