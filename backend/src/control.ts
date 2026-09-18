import { SensorEventSchema } from "@reto/shared";
import type { Action } from "@reto/shared";
import { z } from "zod";
import type { Feed } from "./feed.js";

/** Variantes del cuerpo de POST /api/control; `payload` obligatorio en `inyectar` */
export const esquemaControl = z.discriminatedUnion("accion", [
  z.object({ accion: z.literal("iniciar") }),
  z.object({ accion: z.literal("reiniciar") }),
  z.object({ accion: z.literal("pausar") }),
  z.object({ accion: z.literal("reanudar") }),
  z.object({ accion: z.literal("inyectar"), payload: SensorEventSchema.omit({ id: true }) }),
]);

export interface RegistroAcciones {
  /** Punto de enganche del motor de decisión: registra la acción ya ejecutada, sin gate humano */
  proponer(datos: Omit<Action, "id" | "status" | "timestamp">): Action;
}

export function crearRegistroAcciones(feed: Feed): RegistroAcciones {
  let contador = 0;

  return {
    proponer(datos) {
      contador += 1;
      const accion: Action = {
        ...datos,
        id: `act-${String(contador).padStart(3, "0")}`,
        status: "ejecutada",
        timestamp: new Date().toISOString(),
      };
      feed.publicar({
        kind: "accion",
        elementId: accion.targetElementId,
        actionId: accion.id,
        tipo: accion.type,
        estado: accion.status,
        mensaje: accion.mensaje,
      });
      return accion;
    },
  };
}
