import OpenAI, { APIConnectionError, APIError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { z } from "zod";

/** Presupuesto por intento de gateway: el tick del motor dura 5-10s (DESIGN.md) */
const TIMEOUT_MS = 5_000;

export interface GatewayLlm {
  id: string;
  url: string;
  apiKey: string;
  modelo: string;
  modeloEmbeddings: string;
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
  /** Vectores alineados con `textos` (misma posición y longitud) */
  embeddings(textos: readonly string[]): Promise<number[][]>;
}

/** Clasifica el error según el failover del diseño: timeout/conexión, 429 y 5xx. null = no hay failover */
function motivoFallo(err: unknown): string | null {
  if (err instanceof APIConnectionError) return "timeout o conexión";
  if (err instanceof APIError && err.status !== null) {
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

    embeddings: async (textos) => {
      if (textos.length === 0) return [];
      const { resultado, gw } = await conFailover(({ cliente, gw }: IntentoGateway) =>
        cliente.embeddings.create({ model: gw.modeloEmbeddings, input: [...textos] }),
      );
      const vectores = resultado.data.map((d) => d.embedding);
      if (
        vectores.length !== textos.length ||
        vectores.some((v) => !Array.isArray(v) || v.length === 0)
      ) {
        throw new Error(`gateway ${gw.id} devolvió embeddings incompletos`);
      }
      return vectores;
    },
  };
}
