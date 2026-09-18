import assert from "node:assert/strict";
import { test } from "node:test";
import { parsearSince, crearFeed, type PublicacionFeed } from "../src/feed.js";
import { cargarGuion } from "../src/guion.js";
import { crearSimulacion } from "../src/sim.js";

test("parsearSince acepta entero no negativo y ausencia, rechaza el resto", () => {
  assert.equal(parsearSince(undefined), 0);
  assert.equal(parsearSince("0"), 0);
  assert.equal(parsearSince("7"), 7);
  assert.equal(parsearSince("-1"), null);
  assert.equal(parsearSince("abc"), null);
  assert.equal(parsearSince("1.5"), null);
  assert.equal(parsearSince(""), null);
  assert.equal(parsearSince(["1"]), null);
});

test("el feed asigna seq monotónico y ts, y desde(since) corta sin huecos", () => {
  const feed = crearFeed();
  assert.equal(feed.ultimoSeq(), 0);
  assert.deepEqual(feed.desde(0), []);

  const publicar = (mensaje: string) =>
    feed.publicar({ kind: "sistema", mensaje } satisfies PublicacionFeed);
  publicar("uno");
  publicar("dos");
  publicar("tres");

  const items = feed.desde(0);
  assert.deepEqual(
    items.map((i) => i.seq),
    [1, 2, 3],
  );
  assert.ok(items.every((i) => !Number.isNaN(Date.parse(i.ts))));
  assert.deepEqual(
    feed.desde(1).map((i) => i.seq),
    [2, 3],
  );
  assert.deepEqual(feed.desde(3), []);
  assert.equal(feed.ultimoSeq(), 3);
});

test("la simulación publica los 5 momentos clave como sistema en orden", () => {
  const guion = cargarGuion(
    new URL("../../data/scripts/apagon-madrid.json", import.meta.url),
  );
  const feed = crearFeed();
  const sim = crearSimulacion(guion, Date.now(), feed);

  sim.avanzar(Date.now() + (guion.duracionSegundos + 1) * 1000);

  const notas = guion.timeline.flatMap((e) => (e.nota === undefined ? [] : [e.nota]));
  const sistemas = feed.desde(0).filter((i) => i.kind === "sistema");
  assert.equal(sistemas.length, 5);
  assert.deepEqual(
    sistemas.map((i) => (i.kind === "sistema" ? i.mensaje : "")),
    notas,
  );
});

test("polling por seq reconstruye el feed completo sin perder ni duplicar", () => {
  const guion = cargarGuion(
    new URL("../../data/scripts/apagon-madrid.json", import.meta.url),
  );
  const feed = crearFeed();
  const sim = crearSimulacion(guion, Date.now(), feed);

  // primer poll a mitad de la demo, segundo al final (acumulador por seq)
  sim.avanzar(Date.now() + 60 * 1000);
  const primerPoll = feed.desde(0);
  const cursor = feed.ultimoSeq();
  sim.avanzar(Date.now() + (guion.duracionSegundos + 1) * 1000);
  const segundoPoll = feed.desde(cursor);

  const seqs = [...primerPoll, ...segundoPoll].map((i) => i.seq);
  assert.equal(feed.ultimoSeq(), seqs.length);
  assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, k) => k + 1));

  // toda alarma apunta a un elemento con elementId y métrica del guion
  for (const item of feed.desde(0)) {
    if (item.kind === "alarma") {
      assert.ok(guion.elements.some((e) => e.id === item.elementId));
    }
  }
  // /api/state correlaciona con el feed vía ultimoSeq
  assert.equal(sim.estado().ultimoSeq, feed.ultimoSeq());
});
