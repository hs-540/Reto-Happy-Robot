import { readFileSync } from "node:fs";
import type {
  ElementType,
  ResourceStatus,
  ResourceType,
  SensorMetric,
  TopologyView,
} from "@swarmup/shared";

export interface GuionEventoSensor {
  atSeconds: number;
  kind: "sensor_event";
  nota?: string;
  payload: {
    id: string;
    elementId: string;
    metric: SensorMetric;
    value: number;
    severidad: number;
  };
}

export interface GuionReporte {
  atSeconds: number;
  kind: "reporte";
  nota?: string;
  payload: {
    id: string;
    fuente: "redes" | "llamada_112" | "prensa" | "campo" | "sensor_averiado";
    texto: string;
    elementId: string | null;
  };
}

export interface GuionEventoNarrativo {
  atSeconds: number;
  kind: "narrative";
  nota?: string;
  payload: {
    resourceId?: string;
    evento: string;
  };
}

export type GuionEvento = GuionEventoSensor | GuionEventoNarrativo | GuionReporte;

export interface GuionElemento {
  id: string;
  type: ElementType;
  name: string;
  lat: number;
  lng: number;
  criticidad: number;
}

export interface GuionRecurso {
  id: string;
  type: ResourceType;
  status: ResourceStatus;
  assignedElementId: string | null;
  lat: number;
  lng: number;
}

export interface Guion {
  titulo: string;
  duracionSegundos: number;
  elements: GuionElemento[];
  resources: GuionRecurso[];
  timeline: GuionEvento[];
}

const METRICAS: readonly SensorMetric[] = [
  "temperatura",
  "carga_ups",
  "bateria_generador",
  "cobertura_red",
  "tension_red",
  "bateria_torre",
  "combustible",
  "congestion",
];
const TIPOS_ELEMENTO: readonly ElementType[] = [
  "datacenter",
  "hospital",
  "subestacion",
  "torre",
  "gasolinera",
  "cruce",
];
const TIPOS_RECURSO: readonly ResourceType[] = ["brigada", "generador", "cisterna", "policia"];
const STATUS_RECURSO: readonly ResourceStatus[] = ["disponible", "en_transito", "asignado"];

function esRegistro(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cadena(reg: Record<string, unknown>, clave: string, ruta: string): string {
  const v = reg[clave];
  if (typeof v !== "string") throw new Error(`guion inválido: ${ruta}.${clave} debe ser string`);
  return v;
}

function numero(reg: Record<string, unknown>, clave: string, ruta: string): number {
  const v = reg[clave];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`guion inválido: ${ruta}.${clave} debe ser número`);
  }
  return v;
}

function opcionCadena(reg: Record<string, unknown>, clave: string): string | undefined {
  const v = reg[clave];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new Error(`guion inválido: ${clave} debe ser string`);
  return v;
}

function union<T extends string>(v: unknown, valores: readonly T[], ruta: string): T {
  if (typeof v !== "string" || !valores.includes(v as T)) {
    throw new Error(`guion inválido: ${ruta} debe ser uno de ${valores.join(", ")}`);
  }
  return v as T;
}

function lista(v: unknown, ruta: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`guion inválido: ${ruta} debe ser un array`);
  return v;
}

function validarElemento(v: unknown, ruta: string): GuionElemento {
  if (!esRegistro(v)) throw new Error(`guion inválido: ${ruta} debe ser un objeto`);
  return {
    id: cadena(v, "id", ruta),
    type: union(v.type, TIPOS_ELEMENTO, `${ruta}.type`),
    name: cadena(v, "name", ruta),
    lat: numero(v, "lat", ruta),
    lng: numero(v, "lng", ruta),
    criticidad: numero(v, "criticidad", ruta),
  };
}

function validarRecurso(v: unknown, ruta: string): GuionRecurso {
  if (!esRegistro(v)) throw new Error(`guion inválido: ${ruta} debe ser un objeto`);
  const assigned = v.assignedElementId;
  return {
    id: cadena(v, "id", ruta),
    type: union(v.type, TIPOS_RECURSO, `${ruta}.type`),
    status: union(v.status, STATUS_RECURSO, `${ruta}.status`),
    assignedElementId: assigned === null ? null : cadena(v, "assignedElementId", ruta),
    lat: numero(v, "lat", ruta),
    lng: numero(v, "lng", ruta),
  };
}

function validarEvento(v: unknown, ruta: string): GuionEvento {
  if (!esRegistro(v)) throw new Error(`guion inválido: ${ruta} debe ser un objeto`);
  const atSeconds = numero(v, "atSeconds", ruta);
  const nota = opcionCadena(v, "nota");
  const kind = union(v.kind, ["sensor_event", "narrative", "reporte"], `${ruta}.kind`);
  const payload = v.payload;
  if (!esRegistro(payload)) throw new Error(`guion inválido: ${ruta}.payload debe ser un objeto`);
  if (kind === "sensor_event") {
    return {
      atSeconds,
      kind,
      nota,
      payload: {
        id: cadena(payload, "id", `${ruta}.payload`),
        elementId: cadena(payload, "elementId", `${ruta}.payload`),
        metric: union(payload.metric, METRICAS, `${ruta}.payload.metric`),
        value: numero(payload, "value", `${ruta}.payload`),
        severidad: numero(payload, "severidad", `${ruta}.payload`),
      },
    };
  }
  if (kind === "reporte") {
    const elementId = payload.elementId;
    return {
      atSeconds,
      kind,
      nota,
      payload: {
        id: cadena(payload, "id", `${ruta}.payload`),
        fuente: union(
          payload.fuente,
          ["redes", "llamada_112", "prensa", "campo", "sensor_averiado"] as const,
          `${ruta}.payload.fuente`,
        ),
        texto: cadena(payload, "texto", `${ruta}.payload`),
        elementId: elementId === null ? null : cadena(payload, "elementId", `${ruta}.payload`),
      },
    };
  }
  return {
    atSeconds,
    kind,
    nota,
    payload: {
      evento: cadena(payload, "evento", `${ruta}.payload`),
      resourceId: opcionCadena(payload, "resourceId"),
    },
  };
}

function validarGuion(v: unknown): Guion {
  if (!esRegistro(v)) throw new Error("guion inválido: debe ser un objeto");
  return {
    titulo: cadena(v, "titulo", "guion"),
    duracionSegundos: numero(v, "duracionSegundos", "guion"),
    elements: lista(v.elements, "guion.elements").map((e, i) => validarElemento(e, `elements[${i}]`)),
    resources: lista(v.resources, "guion.resources").map((r, i) => validarRecurso(r, `resources[${i}]`)),
    timeline: lista(v.timeline, "guion.timeline").map((e, i) => validarEvento(e, `timeline[${i}]`)),
  };
}

export function cargarGuion(url: URL): Guion {
  return validarGuion(JSON.parse(readFileSync(url, "utf8")));
}

export function aTopologia(guion: Guion): TopologyView {
  return {
    crisis: {
      titulo: guion.titulo,
      duracionSegundos: guion.duracionSegundos,
      momentos: guion.timeline.flatMap((e) =>
        e.nota === undefined ? [] : [{ atSeconds: e.atSeconds, titulo: e.nota }],
      ),
    },
    elementos: guion.elements.map(({ id, type, name, lat, lng, criticidad }) => ({
      id,
      type,
      name,
      lat,
      lng,
      criticidad,
    })),
    recursos: guion.resources.map(({ id, type, lat, lng }) => ({ id, type, lat, lng })),
  };
}
