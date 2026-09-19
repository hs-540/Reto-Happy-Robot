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
  // ─ sites ─
  /** medical cross */
  hospital: '<path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7V2z" fill="currentColor"/>',
  /** rack stack */
  datacenter:
    '<path d="M3 4h18v5H3V4zm0 6.5h18v5H3v-5zM3 17h18v3H3v-3z" fill="currentColor"/><circle cx="6" cy="6.5" r="1" fill="#000" opacity=".45"/><circle cx="6" cy="13" r="1" fill="#000" opacity=".45"/>',
  /** bolt: a grid node */
  substation: '<path d="M13 1 3 14h7l-1 9 10-13h-7l1-9z" fill="currentColor"/>',
  /** mast with signal arcs */
  tower:
    '<path d="M11 8h2l3 14h-2.6l-.6-3h-3.6l-.6 3H6l3-14z" fill="currentColor"/><path d="M6.5 6.5a7 7 0 0 1 11 0" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M9 4.2a10.5 10.5 0 0 1 6 0" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" opacity=".6"/>',
  /** fuel pump */
  fuel_station:
    '<path d="M4 3h9a1 1 0 0 1 1 1v17H3V4a1 1 0 0 1 1-1zm1.8 2.6v4h5.4v-4H5.8z" fill="currentColor"/><path d="M15.5 8.5h2a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 0 3 0V9l-2.5-3" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  /** traffic light */
  junction:
    '<rect x="7" y="2" width="10" height="16" rx="3" fill="currentColor"/><path d="M12 18v4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="6" r="1.7" fill="#000" opacity=".5"/><circle cx="12" cy="10" r="1.7" fill="#000" opacity=".3"/><circle cx="12" cy="14" r="1.7" fill="#000" opacity=".5"/>',

  // ─ resources ─
  /** hard hat: a human crew */
  crew:
    '<path d="M3 17h18v3H3v-3z" fill="currentColor"/><path d="M12 3a7 7 0 0 1 7 7v5H5v-5a7 7 0 0 1 7-7zm-1.2 1.8A5.2 5.2 0 0 0 7.2 9.4V15h2.1V5.1a5 5 0 0 0-1.5-.3z" fill="currentColor"/>',
  /** generator set: a box with a socket */
  generator:
    '<rect x="2" y="7" width="16" height="10" rx="2" fill="currentColor"/><path d="M18 10h2.5v4H18z" fill="currentColor"/><path d="M7 10.5v3M10 10.5v3" stroke="#000" stroke-width="1.8" stroke-linecap="round" opacity=".5"/>',
  /** tanker: cab plus cylindrical tank */
  tanker:
    '<path d="M2 9h3.5l2 3H2V9z" fill="currentColor"/><rect x="8" y="7.5" width="13" height="7" rx="3.5" fill="currentColor"/><circle cx="6" cy="17" r="2.2" fill="currentColor"/><circle cx="17" cy="17" r="2.2" fill="currentColor"/>',
  /** police cap */
  police:
    '<path d="M2 15h20v3H2v-3z" fill="currentColor"/><path d="M12 4a8 8 0 0 1 8 8v1.5H4V12a8 8 0 0 1 8-8z" fill="currentColor"/><path d="M9.5 9.5 12 6.6l2.5 2.9-2.5 1.6-2.5-1.6z" fill="#000" opacity=".45"/>',
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
  onSelectElement: (id: string) => void
}

export function MapView({
  elements,
  resources,
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
            icon: ICONS[r.type] ?? ICONS.generator,
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
  }, [elements, resources, selectedElementId, onSelectElement, ready])

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
