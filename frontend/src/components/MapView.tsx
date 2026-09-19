import { useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap, Marker } from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ElementView, ResourceView } from '@swarmup/shared'
import { ICON_PATHS, ELEMENT_ICON, RESOURCE_ICON } from './iconPaths'

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

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    carto: {
      type: 'raster',
      tiles: TILES.dark,
      tileSize: 256,
      attribution: '© OpenStreetMap contributors © CARTO',
    },
  },
  layers: [{ id: 'carto', type: 'raster', source: 'carto' }],
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
  node.innerHTML = `<span class="marker__dot"><svg viewBox="0 0 24 24" aria-hidden="true">${spec.icon}</svg></span><span class="marker__label">${spec.label}</span>`
  if (onClick) node.addEventListener('click', onClick)
  return node
}

function applyVariant(entry: MarkerEntry, variant: string) {
  if (entry.variant === variant) return
  entry.node.classList.remove(`marker--${entry.variant}`)
  entry.node.classList.add(`marker--${variant}`)
  entry.variant = variant
}

interface MapViewProps {
  elements: ElementView[]
  resources: ResourceView[]
  selectedElementId: string | null
  theme: 'dark' | 'light'
  onSelectElement: (id: string | null) => void
}

export function MapView({
  elements,
  resources,
  selectedElementId,
  theme,
  onSelectElement,
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

    resources.forEach((r) => {
      alive.add(r.id)
      const entry = store.get(r.id)
      if (entry) {
        applyVariant(entry, r.status)
        entry.marker.setLngLat([r.lng, r.lat])
      } else {
        const node = createMarkerNode(
          {
            kind: 'resource',
            variant: r.status,
            icon: ICON_PATHS[RESOURCE_ICON[r.type] ?? 'generator'] ?? '',
            label: r.id,
          },
          false,
        )
        store.set(r.id, {
          marker: new Marker({ element: node, anchor: 'center' })
            .setLngLat([r.lng, r.lat])
            .addTo(map),
          node,
          variant: r.status,
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
        store.set(el.id, {
          marker: new Marker({ element: node, anchor: 'center' })
            .setLngLat([el.lng, el.lat])
            .addTo(map),
          node,
          variant: el.status,
        })
      }
    })

    for (const [id, entry] of store) {
      if (!alive.has(id)) {
        entry.marker.remove()
        store.delete(id)
      }
    }
  }, [elements, resources, selectedElementId, onSelectElement, ready])

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
