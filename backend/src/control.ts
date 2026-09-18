import { SensorEventSchema } from "@reto/shared";
import type { Action } from "@reto/shared";
import { z } from "zod";
import type { Feed } from "./feed.js";

/** Variantes del cuerpo de POST /api/control; `id`/`payload` obligatorios según `accion` */
export const esquemaControl = z.discriminatedUnion("accion", [
  z.object({ accion: z.literal("pausar") }),
  z.object({ accion: z.literal("reanudar") }),
  z.object({ accion: z.literal("confirmar"), id: z.string().min(1) }),
  z.object({ accion: z.literal("rechazar"), id: z.string().min(1) }),
  z.object({ accion: z.literal("inyectar"), payload: SensorEventSchema.omit({ id: true }) }),
]);

export type ResultadoGate =
  | { ok: true; accion: Action }
  | { ok: false; razon: "desconocida" | "no_propuesta" };

export interface RegistroAcciones {
  /** Punto de enganche del motor de decisión: toda acción real nace `propuesta` */
  proponer(datos: Omit<Action, "id" | "status" | "timestamp">): Action;
  /** Gate: propuesta → confirmada → ejecutada. Sin confirmar, no sale ninguna llamada */
  confirmar(id: string): ResultadoGate;
  /** Gate: propuesta → rechazada */
  rechazar(id: string): ResultadoGate;
}

export function crearRegistroAcciones(feed: Feed): RegistroAcciones {
  const acciones = new Map<string, Action>();
  let contador = 0;

  function publicar(accion: Action): void {
    feed.publicar({
      kind: "accion",
      elementId: accion.targetElementId,
      actionId: accion.id,
      tipo: accion.type,
      estado: accion.status,
      mensaje: accion.mensaje,
    });
  }

  function transicion(id: string, status: Action["status"]): ResultadoGate {
    const accion = acciones.get(id);
    if (!accion) return { ok: false, razon: "desconocida" };
    // gate de seguridad: una acción confirmada o rechazada ya no se toca
    if (accion.status !== "propuesta") return { ok: false, razon: "no_propuesta" };
    const nueva: Action = { ...accion, status };
    acciones.set(id, nueva);
    publicar(nueva);
    return { ok: true, accion: nueva };
  }

  return {
    proponer(datos) {
      contador += 1;
      const accion: Action = {
        ...datos,
        id: `act-${String(contador).padStart(3, "0")}`,
        status: "propuesta",
        timestamp: new Date().toISOString(),
      };
      acciones.set(accion.id, accion);
      publicar(accion);
      return accion;
    },
    confirmar(id) {
      const resultado = transicion(id, "confirmada");
      if (!resultado.ok) return resultado;
      // la llamada real de HappyRobot (#21) se coloca entre confirmada y ejecutada
      const ejecutada: Action = { ...resultado.accion, status: "ejecutada" };
      acciones.set(id, ejecutada);
      publicar(ejecutada);
      return { ok: true, accion: ejecutada };
    },
    rechazar(id) {
      return transicion(id, "rechazada");
    },
  };
}
