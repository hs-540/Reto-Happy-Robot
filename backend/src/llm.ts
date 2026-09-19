import OpenAI, { APIConnectionError, APIError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { z } from "zod";

/**
 * Presupuesto por intento de gateway. Medido en vivo: una deliberación con
 * salida estructurada tarda 4-6s, así que 5s mataba la mayoría de llamadas
 * justo antes de que respondieran. El tick del motor no espera a la
 * deliberación (corre en paralelo), de modo que esto no frena la simulación.
 */
const TIMEOUT_MS = 10_000;

export interface GatewayLlm {
  id: string;
  url: string;
  apiKey: string;
  modelo: string;
}

export interface RespuestaLlm {
  texto: string;
  gateway: string;
  modelo: string;
  latenciaMs: number;
}

export interface RespuestaEstructurada<T> extends RespuestaLlm {
  datos: T;
}

export interface ClienteLlm {
  chat(mensajes: ChatCompletionMessageParam[]): Promise<RespuestaLlm>;
  estructurada<T>(
    mensajes: ChatCompletionMessageParam[],
    esquema: z.ZodType<T>,
    nombre: string,
  ): Promise<RespuestaEstructurada<T>>;
}

/**
 * Clasifica el error para decidir si se prueba el siguiente gateway.
 * Un gateway que rechaza la credencial (401) o niega el servicio (403: key
 * caducada, crédito agotado, cuenta sin verificar) está tan indisponible como
 * uno que devuelve 500 — y esos son justo los fallos que aparecen en directo.
 * `null` = error de nuestra petición, reintentar en otro gateway no ayudaría.
 */
function motivoFallo(err: unknown): string | null {
  if (err instanceof APIConnectionError) return "timeout o conexión";
  if (err instanceof APIError && err.status !== null) {
    if (err.status === 401) return "401 credencial rechazada";
    if (err.status === 403) return "403 servicio denegado (crédito o cuenta)";
    if (err.status === 404) return "404 modelo no servido por este gateway";
    if (err.status === 429) return "429";
    if (err.status >= 500) return `status ${err.status}`;
  }
  return null;
}

interface IntentoGateway {
  gw: GatewayLlm;
  cliente: OpenAI;
}

export function crearClienteLlm(gateways: readonly GatewayLlm[]): ClienteLlm {
  const intentos: IntentoGateway[] = gateways.map((gw) => ({
    gw,
    cliente: new OpenAI({ baseURL: gw.url, apiKey: gw.apiKey, timeout: TIMEOUT_MS, maxRetries: 0 }),
  }));

  async function conFailover<T>(
    operacion: (intento: IntentoGateway) => Promise<T>,
  ): Promise<{ resultado: T; gw: GatewayLlm; latenciaMs: number }> {
    let ultimoError: unknown;
    for (const intento of intentos) {
      const inicio = performance.now();
      try {
        const resultado = await operacion(intento);
        const latenciaMs = Math.round(performance.now() - inicio);
        console.log(`[llm] respuesta vía ${intento.gw.id} (${latenciaMs} ms)`);
        return { resultado, gw: intento.gw, latenciaMs };
      } catch (err) {
        ultimoError = err;
        const motivo = motivoFallo(err);
        if (motivo === null) throw err;
        const haySiguiente = intento !== intentos[intentos.length - 1];
        console.error(
          `[llm] gateway ${intento.gw.id} falló (${motivo})${haySiguiente ? "; failover al siguiente" : "; sin más gateways"}`,
        );
      }
    }
    throw new Error(`todos los gateways fallaron (${gateways.map((g) => g.id).join(", ")})`, {
      cause: ultimoError,
    });
  }

  return {
    chat: async (mensajes) => {
      const { resultado, gw, latenciaMs } = await conFailover(({ cliente, gw }: IntentoGateway) =>
        cliente.chat.completions.create({ model: gw.modelo, messages: mensajes }),
      );
      const texto = resultado.choices?.[0]?.message?.content ?? "";
      if (!texto) throw new Error(`gateway ${gw.id} devolvió una respuesta vacía`);
      return { texto, gateway: gw.id, modelo: gw.modelo, latenciaMs };
    },

    estructurada: async (mensajes, esquema, nombre) => {
      const { resultado, gw, latenciaMs } = await conFailover(({ cliente, gw }: IntentoGateway) =>
        cliente.chat.completions.parse({
          model: gw.modelo,
          messages: mensajes,
          response_format: zodResponseFormat(esquema, nombre),
        }),
      );
      const mensaje = resultado.choices[0]?.message;
      const texto = mensaje?.content ?? "";
      const datos = mensaje?.parsed;
      if (texto === "" || datos == null) {
        throw new Error(`gateway ${gw.id} no devolvió salida estructurada válida`);
      }
      return { texto, datos, gateway: gw.id, modelo: gw.modelo, latenciaMs };
    },
  };
}
