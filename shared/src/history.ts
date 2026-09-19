import { z } from "zod";
import { ElementTypeSchema } from "./script.js";

/* ─── data/history/<type>/incidents.json (pre-loaded RAG history) ─── */

export const HistoricalIncidentSchema = z.object({
  id: z.string().min(1),
  type: ElementTypeSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  outcome: z.string().min(1),
  date: z.iso.date(),
});

export type HistoricalIncident = z.infer<typeof HistoricalIncidentSchema>;
