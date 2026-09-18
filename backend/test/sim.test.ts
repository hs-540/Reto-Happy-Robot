import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FeedItem } from "@swarmup/shared";
import { crearFeed, type Feed } from "../src/feed.js";
import { cargarGuion, type Guion } from "../src/guion.js";
import { crearMundo } from "../src/mundo.js";
import { crearSimulacion, TICK_SEGUNDOS } from "../src/sim.js";

const rutaGuion = fileURLToPath(new URL("../../data/scripts/apagon-madrid.json", import.meta.url));
const INICIO_MS = Date.parse("2026-09-19T10:00:00.000Z");
const DURACION = 300;

function relojIso(seg: number): string {
  return new Date(INICIO_MS + seg * 1000).toISOString();
}

type AlarmaEsperada = {
  kind: "alarma";
  elementId: string;
  metric: string;
  value: number;
  severidad: number;
};
type SistemaEsperado = { kind: "sistema"; mensaje: string };

function itemsEsperados(guion: Guion): (AlarmaEsperada | SistemaEsperado)[] {
  return [...guion.timeline]
    .sort((a, b) => a.atSeconds - b.atSeconds)
    .flatMap((ev) => {
      if (ev.kind === "narrative") {
        return ev.nota === undefined ? [] : [{ kind: "sistema" as const, mensaje: ev.nota }];
      }
      const items: (AlarmaEsperada | SistemaEsperado)[] = [
        {
          kind: "alarma" as const,
          elementId: ev.payload.elementId,
          metric: ev.payload.metric,
          value: ev.payload.value,
          severidad: ev.payload.severidad,
        },
      ];
      if (ev.nota !== undefined) items.push({ kind: "sistema" as const, mensaje: ev.nota });
      return items;
    });
}

/** feed sin el sello del log (seq/ts): el contenido es lo reproducible */
function contenido(items: FeedItem[]): (AlarmaEsperada | SistemaEsperado)[] {
  return items.map((i) =>
    i.kind === "alarma"
      ? {
          kind: i.kind,
          elementId: i.elementId,
          metric: i.metric,
          value: i.value,
          severidad: i.severidad,
        }
      : { kind: i.kind, mensaje: i.mensaje },
  );
}

function simNueva(): { sim: ReturnType<typeof crearSimulacion>; feed: Feed } {
  const feed = crearFeed();
  const guion = cargarGuion(rutaGuion);
  const sim = crearSimulacion(guion, INICIO_MS, feed, crearMundo(guion));
  return { sim, feed };
}

function recorrer(sim: ReturnType<typeof crearSimulacion>, hasta: number = DURACION): void {
  for (let seg = TICK_SEGUNDOS; seg <= hasta; seg += TICK_SEGUNDOS) {
    sim.avanzar(INICIO_MS + seg * 1000);
  }
}

test("sin iniciar, la simulación no avanza ni emite feed", () => {
  const { sim, feed } = simNueva();
  sim.avanzar(INICIO_MS + 60_000);
  sim.avanzar(INICIO_MS + 120_000);
  const estado = sim.estado();
  assert.equal(estado.iniciado, false);
  assert.equal(estado.tick, 0);
  assert.equal(estado.relojSimulacion, relojIso(0));
  assert.deepEqual(feed.desde(0), []);
  assert.equal(feed.ultimoSeq(), 0);
});

test("el guion de 300s genera la timeline completa en orden", () => {
  const guion = cargarGuion(rutaGuion);
  const { sim, feed } = simNueva();
  sim.iniciar(INICIO_MS);
  recorrer(sim);

  const items = feed.desde(0);
  assert.deepEqual(contenido(items), itemsEsperados(guion));
  items.forEach((item, i) => assert.equal(item.seq, i + 1, `seq del item ${i}`));
  assert.equal(sim.estado().ultimoSeq, items.length);
});

test("los 5 momentos clave ocurren en orden y en su segundo exacto", () => {
  const guion = cargarGuion(rutaGuion);
  const momentos = guion.timeline
    .filter((e) => e.nota !== undefined)
    .sort((a, b) => a.atSeconds - b.atSeconds);
  assert.equal(momentos.length, 5);

  const { sim, feed } = simNueva();
  sim.iniciar(INICIO_MS);

  let publicado = 0;
  for (const momento of momentos) {
    sim.avanzar(INICIO_MS + momento.atSeconds * 1000);
    const nuevos = feed.desde(publicado);
    publicado = feed.ultimoSeq();
    assert.ok(nuevos.length > 0, `el momento t=${momento.atSeconds}s no publicó nada`);

    if (momento.kind === "sensor_event") {
      const alarma = nuevos.find(
        (i) =>
          i.kind === "alarma" &&
          i.elementId === momento.payload.elementId &&
          i.value === momento.payload.value,
      );
      assert.ok(alarma, `falta la alarma del momento t=${momento.atSeconds}s`);
      // segundo exacto según el reloj simulado
      const elemento = sim.estado().elementos.find((e) => e.id === momento.payload.elementId);
      assert.equal(elemento?.actualizadoEn, relojIso(momento.atSeconds));
    }

    const ultimo = nuevos[nuevos.length - 1];
    if (ultimo.kind !== "sistema") assert.fail("la nota del momento debe salir como sistema");
    assert.equal(ultimo.mensaje, momento.nota);
  }

  // momento 5: la subestación lleva 60s estable con tensión restaurada → incidente cerrado
  sim.avanzar(INICIO_MS + DURACION * 1000);
  const sub = sim.estado().elementos.find((e) => e.id === "sub-01");
  assert.equal(sub?.status, "resuelto");
});

test("reiniciar deja el estado inicial reproducible y una repetición idéntica", () => {
  const { sim, feed } = simNueva();
  sim.iniciar(INICIO_MS);
  recorrer(sim);
  const estadoFinal = sim.estado();
  const feedFinal = contenido(feed.desde(0));
  const seqFinal = feed.ultimoSeq();
  assert.ok(feedFinal.length > 0);

  sim.reiniciar();
  // el cursor nunca retrocede: el acumulador del frontend no ve seq reusados
  assert.equal(feed.ultimoSeq(), seqFinal);
  assert.deepEqual(feed.desde(0), []);
  // el mundo queda exactamente como uno recién creado (salvo el cursor del feed)
  const estadoReset = sim.estado();
  const fresco = simNueva();
  assert.deepEqual(estadoReset, { ...fresco.sim.estado(), ultimoSeq: estadoReset.ultimoSeq });

  sim.iniciar(INICIO_MS);
  recorrer(sim);
  assert.deepEqual(contenido(feed.desde(seqFinal)), feedFinal);
  assert.deepEqual(sim.estado(), { ...estadoFinal, ultimoSeq: feed.ultimoSeq() });
});

test("inyectar aplica un sensor event inmediato y lo emite en el feed", () => {
  const { sim, feed } = simNueva();
  sim.iniciar(INICIO_MS);
  sim.avanzar(INICIO_MS + 10_000);
  const seqAntes = feed.ultimoSeq();

  sim.inyectar({ elementId: "dc-01", metric: "temperatura", value: 55, severidad: 80 });

  const dc = sim.estado().elementos.find((e) => e.id === "dc-01");
  assert.equal(dc?.sensores.temperatura, 55);
  assert.equal(dc?.severidad, 80);
  assert.equal(dc?.status, "critico");
  assert.equal(dc?.actualizadoEn, relojIso(10));

  const nuevos = feed.desde(seqAntes);
  assert.equal(nuevos.length, 1);
  const item = nuevos[0];
  if (item.kind !== "alarma") assert.fail("la inyección debe emitir una alarma");
  assert.equal(item.elementId, "dc-01");
  assert.equal(item.metric, "temperatura");
  assert.equal(item.value, 55);
  assert.equal(item.severidad, 80);

  assert.throws(
    () => sim.inyectar({ elementId: "no-existe", metric: "temperatura", value: 1, severidad: 1 }),
    /desconocido/,
  );
});
