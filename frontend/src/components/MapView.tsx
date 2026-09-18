import { useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ElementView, ResourceView } from '@swarmup/shared'

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

const ICONS: Record<string, string> = {
  hospital:
    '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3z" fill="currentColor"/>',
  datacenter:
    '<path d="M4 5h16v4H4V5zm0 6h16v4H4v-4zm0 6h16v4H4v-4z" fill="currentColor"/>',
  subestacion:
    '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z" fill="currentColor"/>',
  cuadrilla:
    '<path d="M3 7h11a4 4 0 0 1 4 3h1a2 2 0 0 1 2 2v3h-2.1a3 3 0 0 1-5.8 0H9.9a3 3 0 0 1-5.8 0H2V9a2 2 0 0 1 1-2z" fill="currentColor"/>',
  generador:
    '<path d="M4 7h15v3h2v4h-2v3H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2zm3 3v4h2v-4H7z" fill="currentColor"/>',
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
  elementos: ElementView[]
  recursos: ResourceView[]
  selectedElementId: string | null
  onSelectElement: (id: string) => void
}

export function MapView({
  elementos,
  recursos,
  selectedElementId,
  onSelectElement,
}: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const markersRef = useRef<Map<string, MarkerEntry>>(new Map())
  const prevSelectedRef = useRef<string | null | undefined>(selectedElementId)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new MapLibreMap({
      container: containerRef.current,
      style: STYLE,
      center: [-3.72, 40.302],
      zoom: 13.4,
      minZoom: 10,
      dragRotate: false,
      attributionControl: { compact: true },
    })
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right')
    map.on('load', () => {
      if (mapRef.current === map) setReady(true)
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

    recursos.forEach((r) => {
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
            icon: ICONS[r.type] ?? ICONS.generador,
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

    elementos.forEach((el) => {
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
            icon: ICONS[el.type] ?? ICONS.hospital,
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
  }, [elementos, recursos, selectedElementId, onSelectElement, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const prev = prevSelectedRef.current
    prevSelectedRef.current = selectedElementId
    if (prev === selectedElementId || !selectedElementId) return
    const el = elementos.find((e) => e.id === selectedElementId)
    if (!el) return
    map.flyTo({
      center: [el.lng, el.lat],
      zoom: Math.max(map.getZoom(), 14.2),
      duration: 800,
    })
  }, [selectedElementId, elementos, ready])

  return <div className="map" ref={containerRef} />
}
