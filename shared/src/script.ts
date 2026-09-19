import { z } from "zod";

/* ─── Contract primitives: the schemas are the single source of truth ─── */

export const ElementTypeSchema = z.enum(["datacenter", "hospital", "substation"]);

export const ResourceTypeSchema = z.enum(["crew", "generator"]);

export const ElementStatusSchema = z.enum(["normal", "degraded", "critical", "resolved"]);

export const ResourceStatusSchema = z.enum(["available", "in_transit", "assigned"]);

export const SensorMetricSchema = z.enum([
  "temperature",
  "ups_load",
  "generator_battery",
  "network_coverage",
  "grid_voltage",
]);

/* ─── data/scripts/*.json ─── */

export const ScriptElementSchema = z.object({
  id: z.string().min(1),
  type: ElementTypeSchema,
  name: z.string().min(1),
  lat: z.number().finite(),
  lng: z.number().finite(),
  status: ElementStatusSchema,
  /** 0-100, the higher the more critical it is to lose this element */
  criticality: z.number().min(0).max(100),
});

export const ScriptResourceSchema = z.object({
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
  severity: z.number().min(0).max(100),
});

export const NarrativeEventSchema = z.object({
  resourceId: z.string().min(1),
  event: z.string().min(1),
});

export const ScriptEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    /** Offset in seconds from the start of the script */
    atSeconds: z.number().int().min(0),
    kind: z.literal("sensor_event"),
    note: z.string().min(1).optional(),
    payload: SensorEventSchema,
  }),
  z.object({
    atSeconds: z.number().int().min(0),
    kind: z.literal("narrative"),
    note: z.string().min(1).optional(),
    payload: NarrativeEventSchema,
  }),
]);

export const ScriptSchema = z.object({
  title: z.string().min(1),
  durationSeconds: z.number().int().positive(),
  elements: z.array(ScriptElementSchema),
  resources: z.array(ScriptResourceSchema),
  timeline: z.array(ScriptEntrySchema),
});

export type ScriptElement = z.infer<typeof ScriptElementSchema>;
export type ScriptResource = z.infer<typeof ScriptResourceSchema>;
export type SensorEvent = z.infer<typeof SensorEventSchema>;
export type NarrativeEvent = z.infer<typeof NarrativeEventSchema>;
export type ScriptEntry = z.infer<typeof ScriptEntrySchema>;
export type Script = z.infer<typeof ScriptSchema>;
