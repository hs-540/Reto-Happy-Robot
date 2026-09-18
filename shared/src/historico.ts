import { z } from "zod";
import { ElementTypeSchema } from "./guion.js";

/* ─── data/history/<tipo>/incidentes.json (histórico RAG pre-cargado) ─── */

export const HistoricoIncidenteSchema = z.object({
  id: z.string().min(1),
  tipo: ElementTypeSchema,
  titulo: z.string().min(1),
  resumen: z.string().min(1),
  resultado: z.string().min(1),
  fecha: z.iso.date(),
});

export type HistoricoIncidente = z.infer<typeof HistoricoIncidenteSchema>;
