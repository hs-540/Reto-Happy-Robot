import { useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap, Marker } from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ElementView, LatLng, RepairEstimate, ResourceView } from '@swarmup/shared'
import { ICON_PATHS, ELEMENT_ICON, RESOURCE_ICON } from './iconPaths'
import { resourceColor } from '../lib/palette'
import { formatCountdown } from '../lib/format'

/**
 * Stadia serves the raster basemap. It is free without a key on localhost; a
 * deployed host needs a free Stadia account and its key in VITE_MAP_TILE_KEY.
 */
const TILE_KEY = import.meta.env.VITE_MAP_TILE_KEY as string | undefined
const TILE_QUERY = TILE_KEY ? `?api_key=${TILE_KEY}` : ''

const tileUrls = (style: string): string[] => [
  `https://tiles.stadiamaps.com/tiles/${style}/{z}/{x}/{y}@2x.png${TILE_QUERY}`,
]

const TILES: Record<'dark' | 'light', string[]> = {
  dark: tileUrls('alidade_smooth_dark'),
  light: tileUrls('alidade_smooth'),
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

interface FlowCollection {
  type: 'FeatureCollection'
  features: {
    type: 'Feature'
    properties: { color: string; bearing: number }
    geometry: { type: 'Point'; coordinates: [number, number] }
  }[]
}

const EMPTY_FLOW: FlowCollection = { type: 'FeatureCollection', features: [] }

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    basemap: {
      type: 'raster',
      tiles: TILES.dark,
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © OpenMapTiles © Stadia Maps',
    },
    routes: {
      type: 'geojson',
      data: EMPTY_ROUTES,
    },
  },
  layers: [
    { id: 'basemap', type: 'raster', source: 'basemap' },
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

/**
 * The arrowhead stamped along a route. Drawn once into a canvas and registered
 * as an SDF image, so the symbol layer can tint it with the resource colour; the
 * slight blur turns the alpha edge into a soft distance ramp, which is what SDF
 * rendering expects. The shape points up (north) and MapLibre rotates it to the
 * line's bearing.
 */
function arrowImage(): ImageData {
  const size = 48
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return new ImageData(size, size)
  ctx.filter = 'blur(1.5px)'
  ctx.fillStyle = '#fff'
  ctx.fill(new Path2D('M24 4 L42 40 L24 30 L6 40 Z'))
  return ctx.getImageData(0, 0, size, size)
}

/**
 * Dash pattern of `route-line` scaled to px (dash 0.1 * 2.5 and gap 2 * 2.5).
 * Arrow spacing is expressed in dots so the flow reads the same at any zoom.
 */
const DASH_PERIOD_PX = 5.25

/** Arrows are placed every this many dots, in screen space */
const ARROW_GAP_DOTS = 8

/** Seconds an arrow takes to travel one gap, so the flow speed is zoom-independent */
const FLOW_PERIOD_S = 3.5

/** Meters between two lng/lat points; equirectangular, exact enough at city scale */
function metersBetween(a: [number, number], b: [number, number]): number {
  const mx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180)) * 111_320
  const my = (b[1] - a[1]) * 110_540
  return Math.hypot(mx, my)
}

/** Compass bearing (0° = north, clockwise) from a to b on a north-up map */
function bearingBetween(a: [number, number], b: [number, number]): number {
  const dLng = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180))
  const dLat = b[1] - a[1]
  return ((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360
}

/**
 * Points every `spacing` meters along the polyline, each carrying the bearing of
 * the segment it sits on, starting `phase` meters in. Advancing the phase each
 * frame is what makes the arrows travel from the unit towards the target.
 */
function flowFeatures(
  coords: [number, number][],
  color: string,
  spacing: number,
  phase: number,
): FlowCollection['features'] {
  const features: FlowCollection['features'] = []
  const step = Math.max(spacing, 1)
  let travelled = 0
  let next = ((phase % step) + step) % step
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]
    const b = coords[i + 1]
    const seg = metersBetween(a, b)
    if (seg === 0) continue
    const bearing = bearingBetween(a, b)
    while (next <= travelled + seg) {
      const t = (next - travelled) / seg
      features.push({
        type: 'Feature',
        properties: { color, bearing },
        geometry: {
          type: 'Point',
          coordinates: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t],
        },
      })
      next += step
    }
    travelled += seg
  }
  return features
}

/** Ground meters covered by one screen pixel at the given point and zoom */
function metersPerPixel(map: MapLibreMap, lngLat: [number, number]): number {
  const p = map.project(lngLat)
  const edge = map.unproject([p.x + 100, p.y])
  return metersBetween(lngLat, [edge.lng, edge.lat]) / 100
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
  /** the rotating direction arrow around the dot; sites do not have one */
  dir: HTMLElement | null
  /**
   * Continuous CSS angle (it may drift past 360° to avoid a full spin when the
   * heading wraps around), or null while the resource has no heading to show.
   */
  heading: number | null
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
  // The arrow orbits the dot, so it lives in a layer that covers the dot and
  // rotates around its centre while the type icon stays upright.
  const dir =
    spec.kind === 'resource'
      ? `<span class="marker__dir" hidden><span class="marker__arrow"><svg viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS.arrow}</svg></span></span>`
      : ''
  node.innerHTML = `<span class="marker__dot"><svg viewBox="0 0 24 24" aria-hidden="true">${spec.icon}</svg>${dir}${eta}</span><span class="marker__label">${spec.label}</span>`
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
 * Compass heading (0° = north, clockwise) of the route segment the resource is
 * currently on. Longitude is scaled by cos(lat) so the angle matches what the
 * marker sees on the north-up Mercator map, unlike a raw lat/lng atan2.
 */
function headingAlongRoute(route: LatLng[], pos: [number, number]): number | null {
  let idx = 0
  let best = Infinity
  for (let i = 0; i < route.length - 1; i++) {
    const ax = route[i].lng
    const ay = route[i].lat
    const vx = route[i + 1].lng - ax
    const vy = route[i + 1].lat - ay
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
    }
  }
  const a = route[idx]
  const b = route[idx + 1]
  const dLat = b.lat - a.lat
  const dLng = (b.lng - a.lng) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180))
  if (dLat === 0 && dLng === 0) return null
  return ((Math.atan2(dLng, dLat) * 180) / Math.PI + 360) % 360
}

/**
 * Point the arrow along the road. The stored angle is kept continuous: when the
 * bearing wraps (359° → 1°) the shortest turn is taken instead of a full spin.
 */
function applyHeading(entry: MarkerEntry, resource: ResourceView) {
  const dir = entry.dir
  if (!dir) return
  if (resource.status !== 'in_transit' || !resource.route || resource.route.length < 2) {
    dir.hidden = true
    entry.heading = null
    return
  }
  let heading = headingAlongRoute(resource.route, [resource.lng, resource.lat])
  if (heading === null) {
    dir.hidden = true
    entry.heading = null
    return
  }
  dir.hidden = false
  const prev = entry.heading
  if (prev !== null) {
    heading = prev + ((((heading - prev) % 360) + 540) % 360) - 180
  }
  entry.heading = heading
  dir.style.transform = `rotate(${heading}deg)`
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
  /** the routes currently drawn, read by the flow animation every frame */
  const routesRef = useRef<RouteCollection['features']>([])
  /** how far along the route the flowing arrows are, in meters */
  const flowPhaseRef = useRef(0)

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
      if (mapRef.current !== map) return
      // The image must exist before the layer that references it, so both are
      // added once the style is up rather than declared in STYLE.
      map.addImage('route-arrow', arrowImage(), { sdf: true })
      map.addSource('route-flow', { type: 'geojson', data: EMPTY_FLOW })
      map.addLayer({
        id: 'route-flow-arrows',
        type: 'symbol',
        source: 'route-flow',
        // The points are placed in JS and moved every frame, so the layer only
        // rotates each arrow to its segment bearing and tints it per resource.
        layout: {
          'icon-image': 'route-arrow',
          'icon-size': 0.4,
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
        paint: {
          'icon-color': ['get', 'color'],
          'icon-opacity': 0.9,
        },
      })
      setReady(true)
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
      routesRef.current = features
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
        applyHeading(entry, r)
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
        const created: MarkerEntry = {
          marker: new Marker({ element: node, anchor: 'center' })
            .setLngLat([r.lng, r.lat])
            .addTo(map),
          node,
          variant: r.status,
          eta: null,
          dir: node.querySelector('.marker__dir'),
          heading: null,
        }
        applyHeading(created, r)
        store.set(r.id, created)
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
          dir: null,
          heading: null,
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
    const source = map.getSource('basemap')
    if (source && 'setTiles' in source) {
      ;(source as { setTiles: (tiles: string[]) => void }).setTiles(TILES[theme])
    }
  }, [theme, ready])

  /**
   * Arrows flow from the unit to its target. MapLibre 6 dropped
   * `line-dashoffset`, so the movement is not a paint trick: the arrows are
   * points recomputed along the route every frame, spaced a fixed number of dots
   * apart on screen and advanced by one gap per `FLOW_PERIOD_S`.
   */
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const source = map.getSource('route-flow')
    if (!source || !('setData' in source)) return
    const setData = (data: FlowCollection) =>
      (source as { setData: (d: FlowCollection) => void }).setData(data)
    let frame = 0
    let last = 0
    let wasActive = false
    const tick = (now: number) => {
      const delta = last === 0 ? 0 : (now - last) / 1000
      last = now
      const routes = routesRef.current
      if (routes.length === 0) {
        if (wasActive) {
          setData(EMPTY_FLOW)
          wasActive = false
        }
      } else {
        const head = routes[0].geometry.coordinates[0]
        const spacing = ARROW_GAP_DOTS * DASH_PERIOD_PX * metersPerPixel(map, head)
        flowPhaseRef.current += (spacing / FLOW_PERIOD_S) * delta
        setData({
          type: 'FeatureCollection',
          features: routes.flatMap((f) =>
            flowFeatures(f.geometry.coordinates, f.properties.color, spacing, flowPhaseRef.current),
          ),
        })
        wasActive = true
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [ready])

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
