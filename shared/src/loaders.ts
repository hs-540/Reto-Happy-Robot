import { readFileSync } from "node:fs";
import { z } from "zod";
import { GuionSchema, type Guion } from "./guion.js";
import { HistoricoIncidenteSchema, type HistoricoIncidente } from "./historico.js";

/* ─── Parseo puro: unknown → tipo validado, con errores accionables ─── */

function valorEn(input: unknown, path: readonly PropertyKey[]): unknown {
  let actual: unknown = input;
  for (const clave of path) {
    if (actual === null || typeof actual !== "object") {
      return undefined;
    }
    actual = (actual as Record<PropertyKey, unknown>)[clave];
  }
  return actual;
}

function parsear<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const detalles = result.error.issues
      .map((issue) => {
        const campo = issue.path.length > 0 ? issue.path.join(".") : "(raíz)";
        return `campo '${campo}': ${issue.message} (recibido: ${JSON.stringify(valorEn(input, issue.path))})`;
      })
      .join("\n");
    throw new Error(`Datos inválidos:\n${detalles}`);
  }
  return result.data;
}

export function parseGuion(input: unknown): Guion {
  return parsear(GuionSchema, input);
}

export function parseHistorico(input: unknown): HistoricoIncidente[] {
  return parsear(z.array(HistoricoIncidenteSchema), input);
}

/* ─── Carga desde fichero: lectura + JSON.parse + validación ─── */

function mensajeDe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cargarJson<T>(ruta: string, parse: (input: unknown) => T): T {
  let texto: string;
  try {
    texto = readFileSync(ruta, "utf8");
  } catch (error) {
    throw new Error(`No se pudo leer '${ruta}': ${mensajeDe(error)}`);
  }
  let datos: unknown;
  try {
    datos = JSON.parse(texto);
  } catch (error) {
    throw new Error(`'${ruta}' no es JSON válido: ${mensajeDe(error)}`);
  }
  try {
    return parse(datos);
  } catch (error) {
    throw new Error(`'${ruta}': ${mensajeDe(error)}`);
  }
}

export function cargarGuion(ruta: string): Guion {
  return cargarJson(ruta, parseGuion);
}

export function cargarHistorico(ruta: string): HistoricoIncidente[] {
  return cargarJson(ruta, parseHistorico);
}
