import type { FeedItem } from "@reto/shared";

/** FeedItem sin el sello del log: `seq` y `ts` los asigna el feed al publicar */
type SinSello<T> = T extends unknown ? Omit<T, "seq" | "ts"> : never;
export type PublicacionFeed = SinSello<FeedItem>;

export interface Feed {
  publicar(item: PublicacionFeed): void;
  /** ítems con `seq > since` (contrato CONTRACT.md: sin `since` → feed completo) */
  desde(since: number): FeedItem[];
  ultimoSeq(): number;
  /** Vacía los ítems del run anterior; el contador sigue monotónico para no romper el acumulador por `seq` */
  reiniciar(): void;
}

/**
 * La retención guarda la demo completa en memoria: 4-5 min de guion son ~15
 * ítems, así que recortar la cola rompería el polling por `since` sin beneficio.
 */
export function crearFeed(): Feed {
  const items: FeedItem[] = [];
  let ultimo = 0;
  return {
    publicar(item) {
      ultimo += 1;
      items.push({ ...item, seq: ultimo, ts: new Date().toISOString() });
    },
    desde(since) {
      return items.filter((item) => item.seq > since);
    },
    ultimoSeq() {
      return ultimo;
    },
    reiniciar() {
      items.length = 0;
    },
  };
}

/** `since` ausente → 0 (todo el feed); inválido → null (el route responde 400) */
export function parsearSince(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}
