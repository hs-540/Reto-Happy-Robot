import { z } from "zod";
import { ElementTypeSchema, ResourceTypeSchema } from "./script.js";

/* ─── data/topology.json: what depends on what ─────────────────────────
 * Physical facts about the scenario. Never priorities or decisions: put a
 * judgement in here and the decision engine moves into the JSON, leaving the
 * agent decorative.
 */

export const EdgeTypeSchema = z.enum([
  /** the source supplies grid power to the target */
  "supplies",
  /** while the source stands, calls and messages can be made */
  "enables_comms",
  /** while the source is regulated, journeys take their normal time */
  "enables_transit",
  /** the source is where the target replenishes its load */
  "refuels",
]);

export const EdgeSchema = z.object({
  from: z.string().min(1),
  /** element or resource id, or "*" when it affects the whole scenario */
  to: z.string().min(1),
  type: EdgeTypeSchema,
  note: z.string().min(1).optional(),
});

export const TopologySchema = z.object({
  $comment: z.string().optional(),
  edges: z.array(EdgeSchema),
});

/* ─── data/remedies.json: what fixes what and at what cost ─── */

export const RemedySchema = z.object({
  resource: ResourceTypeSchema,
  solves: z.string().min(1),
  appliesTo: z.array(ElementTypeSchema),
  minutes: z.number().int().positive(),
  effect: z.string().min(1),
  /**
   * The resource IS the missing service while it stays on site (a connected
   * generator, police directing the junction), so it is only free once the site
   * stops needing it. `false` is a one-shot job — repairing, refuelling — and
   * the resource leaves as soon as the remedy takes hold.
   */
  sustains: z.boolean(),
  /** precondition without which the remedy is useless */
  requires: z.string().min(1).nullable(),
  $note: z.string().optional(),
});

export const ContactSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  /** resource they lead, if they lead one */
  resourceId: z.string().min(1).optional(),
  /** site they answer for, if they answer for one */
  elementId: z.string().min(1).optional(),
  /** number HappyRobot dials; without it the contact only receives messages */
  phone: z.string().min(1).optional(),
  $note: z.string().optional(),
});

export const RemediesSchema = z.object({
  $comment: z.string().optional(),
  remedies: z.array(RemedySchema),
  contacts: z.array(ContactSchema),
});

export type EdgeType = z.infer<typeof EdgeTypeSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type Topology = z.infer<typeof TopologySchema>;
export type Remedy = z.infer<typeof RemedySchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type Remedies = z.infer<typeof RemediesSchema>;

/** Elements left without grid power if `id` falls, following `supplies` edges */
export function dependentsOf(topology: Topology, id: string): string[] {
  const direct = topology.edges
    .filter((e) => e.from === id && e.type === "supplies")
    .map((e) => e.to);
  return [...new Set(direct.flatMap((d) => [d, ...dependentsOf(topology, d)]))];
}
