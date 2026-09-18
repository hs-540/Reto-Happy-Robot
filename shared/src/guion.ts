import { z } from "zod";

/* ─── Primitivas del contrato: los esquemas son la fuente única ─── */

export const ElementTypeSchema = z.enum(["datacenter", "hospital", "subestacion"]);

export const ResourceTypeSchema = z.enum(["cuadrilla", "generador"]);

export const ElementStatusSchema = z.enum(["normal", "degradado", "critico", "resuelto"]);

export const ResourceStatusSchema = z.enum(["disponible", "en_transito", "asignado"]);

export const SensorMetricSchema = z.enum([
  "temperatura",
  "carga_ups",
  "bateria_generador",
  "cobertura_red",
  "tension_red",
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
export type EntradaGuion = z.infer<typeof EntradaGuionSchema>;
export type Guion = z.infer<typeof GuionSchema>;
