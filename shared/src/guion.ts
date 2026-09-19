import { z } from "zod";

/* ─── Primitivas del contrato: los esquemas son la fuente única ─── */

export const ElementTypeSchema = z.enum([
  "datacenter",
  "hospital",
  "subestacion",
  "torre",
  "gasolinera",
  "cruce",
]);

export const ResourceTypeSchema = z.enum(["brigada", "generador", "cisterna", "policia"]);

export const ElementStatusSchema = z.enum(["normal", "degradado", "critico", "resuelto"]);

export const ResourceStatusSchema = z.enum(["disponible", "en_transito", "asignado"]);

export const SensorMetricSchema = z.enum([
  "temperatura",
  "carga_ups",
  "bateria_generador",
  "cobertura_red",
  "tension_red",
  /** % de batería de la torre de telecomunicaciones */
  "bateria_torre",
  /** litros restantes en el depósito de un generador o surtidor */
  "combustible",
  /** minutos de retraso que el tráfico añade a cualquier trayecto */
  "congestion",
]);

/* ─── data/scripts/*.json ─── */

export const ElementoGuionSchema = z.object({
  id: z.string().min(1),
  type: ElementTypeSchema,
  name: z.string().min(1),
  lat: z.number().finite(),
  lng: z.number().finite(),
  status: ElementStatusSchema,
  /** 0-100, cuanto más alto más crítico es perder este elemento */
  criticidad: z.number().min(0).max(100),
});

export const RecursoGuionSchema = z.object({
  id: z.string().min(1),
  type: ResourceTypeSchema,
  status: ResourceStatusSchema,
  assignedElementId: z.string().min(1).nullable(),
  lat: z.number().finite(),
  lng: z.number().finite(),
});

export const SensorEventSchema = z.object({
  id: z.string().min(1),
  elementId: z.string().min(1),
  metric: SensorMetricSchema,
  value: z.number().finite(),
  severidad: z.number().min(0).max(100),
});

/** Señal entrante en lenguaje natural: la mayoría es ruido y el agente debe cribarla */
export const ReporteSchema = z.object({
  id: z.string().min(1),
  fuente: z.enum(["redes", "llamada_112", "prensa", "campo", "sensor_averiado"]),
  texto: z.string().min(1),
  /** Sitio al que alude, si es que alude a alguno */
  elementId: z.string().min(1).nullable(),
});

export const EventoNarrativoSchema = z.object({
  resourceId: z.string().min(1),
  evento: z.string().min(1),
});

export const EntradaGuionSchema = z.discriminatedUnion("kind", [
  z.object({
    /** Offset en segundos desde el inicio del guion */
    atSeconds: z.number().int().min(0),
    kind: z.literal("sensor_event"),
    nota: z.string().min(1).optional(),
    payload: SensorEventSchema,
  }),
  z.object({
    atSeconds: z.number().int().min(0),
    kind: z.literal("narrative"),
    nota: z.string().min(1).optional(),
    payload: EventoNarrativoSchema,
  }),
  z.object({
    atSeconds: z.number().int().min(0),
    kind: z.literal("reporte"),
    nota: z.string().min(1).optional(),
    payload: ReporteSchema,
  }),
]);

export const GuionSchema = z.object({
  titulo: z.string().min(1),
  duracionSegundos: z.number().int().positive(),
  elements: z.array(ElementoGuionSchema),
  resources: z.array(RecursoGuionSchema),
  timeline: z.array(EntradaGuionSchema),
});

export type ElementoGuion = z.infer<typeof ElementoGuionSchema>;
export type RecursoGuion = z.infer<typeof RecursoGuionSchema>;
export type SensorEvent = z.infer<typeof SensorEventSchema>;
export type EventoNarrativo = z.infer<typeof EventoNarrativoSchema>;
export type Reporte = z.infer<typeof ReporteSchema>;
export type EntradaGuion = z.infer<typeof EntradaGuionSchema>;
export type Guion = z.infer<typeof GuionSchema>;
