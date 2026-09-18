import { useEffect, useRef, useState } from 'react'
import { Map as MapLibreMap, Marker, NavigationControl } from 'maplibre-gl'
import type { StyleSpecification } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { ElementView, ResourceView } from '@reto/shared'

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

function markerNode(
  opts: {
    kind: 'element' | 'resource'
    variant: string
    icon: string
    label: string
    selected?: boolean
    onClick?: () => void
  },
): HTMLElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = [
    'marker',
    `marker--${opts.kind}`,
    `marker--${opts.variant}`,
    opts.selected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ')
  node.innerHTML = `<span class="marker__dot"><svg viewBox="0 0 24 24" aria-hidden="true">${opts.icon}</svg></span><span class="marker__label">${opts.label}</span>`
  if (opts.onClick) node.addEventListener('click', opts.onClick)
  return node
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
  const markersRef = useRef<Marker[]>([])
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
    map.on('load', () => setReady(true))
    mapRef.current = map
    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    recursos.forEach((r) => {
      const svg = ICONS[r.type] ?? ICONS.generador
      const node = markerNode({
        kind: 'resource',
        variant: r.status,
        icon: svg,
        label: r.id,
      })
      markersRef.current.push(
        new Marker({ element: node, anchor: 'center' })
          .setLngLat([r.lng, r.lat])
          .addTo(map),
      )
    })

    elementos.forEach((el) => {
      const svg = ICONS[el.type] ?? ICONS.hospital
      const node = markerNode({
        kind: 'element',
        variant: el.status,
        icon: svg,
        label: el.name,
        selected: el.id === selectedElementId,
        onClick: () => onSelectElement(el.id),
      })
      markersRef.current.push(
        new Marker({ element: node, anchor: 'center' })
          .setLngLat([el.lng, el.lat])
          .addTo(map),
      )
    })
  }, [elementos, recursos, selectedElementId, onSelectElement, ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !selectedElementId) return
    const el = elementos.find((e) => e.id === selectedElementId)
    if (!el) return
    map.flyTo({ center: [el.lng, el.lat], zoom: 14.2, duration: 800 })
  }, [selectedElementId, elementos, ready])

  return <div className="map" ref={containerRef} />
}
