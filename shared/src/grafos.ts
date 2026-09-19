import { z } from "zod";
import { ElementTypeSchema, ResourceTypeSchema } from "./guion.js";

/* ─── data/topologia.json: qué depende de qué ───────────────────────────
 * Hechos físicos del escenario. Nunca prioridades ni decisiones: si un juicio
 * entra aquí, el motor de decisión pasa a vivir en el JSON y el agente sobra.
 */

export const TipoAristaSchema = z.enum([
  /** el origen suministra red eléctrica al destino */
  "alimenta",
  /** mientras el origen esté en pie se pueden hacer llamadas y enviar mensajes */
  "habilita_comunicacion",
  /** mientras el origen esté regulado, los desplazamientos tardan lo normal */
  "habilita_transito",
  /** el origen es donde el destino repone su carga */
  "reabastece",
]);

export const AristaSchema = z.object({
  de: z.string().min(1),
  /** id de elemento o recurso, o "*" si afecta a todo el escenario */
  a: z.string().min(1),
  tipo: TipoAristaSchema,
  nota: z.string().min(1).optional(),
});

export const TopologiaSchema = z.object({
  $comentario: z.string().optional(),
  aristas: z.array(AristaSchema),
});

/* ─── data/remedios.json: qué arregla qué y a qué coste ─── */

export const RemedioSchema = z.object({
  recurso: ResourceTypeSchema,
  resuelve: z.string().min(1),
  aplicableA: z.array(ElementTypeSchema),
  minutos: z.number().int().positive(),
  efecto: z.string().min(1),
  /** condición previa sin la cual el remedio no sirve */
  requiere: z.string().min(1).nullable(),
  $nota: z.string().optional(),
});

export const ContactoSchema = z.object({
  id: z.string().min(1),
  nombre: z.string().min(1),
  rol: z.string().min(1),
  /** recurso que dirige, si dirige alguno */
  recursoId: z.string().min(1).optional(),
  /** sitio del que responde, si responde de alguno */
  elementId: z.string().min(1).optional(),
  /** número al que llama HappyRobot; sin él, el contacto solo recibe mensajes */
  telefono: z.string().min(1).optional(),
  $nota: z.string().optional(),
});

export const RemediosSchema = z.object({
  $comentario: z.string().optional(),
  remedios: z.array(RemedioSchema),
  contactos: z.array(ContactoSchema),
});

export type TipoArista = z.infer<typeof TipoAristaSchema>;
export type Arista = z.infer<typeof AristaSchema>;
export type Topologia = z.infer<typeof TopologiaSchema>;
export type Remedio = z.infer<typeof RemedioSchema>;
export type Contacto = z.infer<typeof ContactoSchema>;
export type Remedios = z.infer<typeof RemediosSchema>;

/** Elementos que quedan sin red si cae `id`, siguiendo las aristas `alimenta` */
export function dependientesDe(topologia: Topologia, id: string): string[] {
  const directos = topologia.aristas
    .filter((a) => a.de === id && a.tipo === "alimenta")
    .map((a) => a.a);
  return [...new Set(directos.flatMap((d) => [d, ...dependientesDe(topologia, d)]))];
}
