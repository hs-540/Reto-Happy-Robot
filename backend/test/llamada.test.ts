import assert from "node:assert/strict";
import test from "node:test";
import type { CierreLlamada, FeedItem } from "@swarmup/shared";
import { crearFeed } from "../src/feed.js";
import { crearRegistroAcciones } from "../src/control.js";

/** El cierre de llamada se publica tal cual llega: es la prueba ante el jurado */
function resultados(items: FeedItem[]) {
  return items.flatMap((i) =>
    i.kind === "resultado"
      ? [{ actionId: i.actionId, resultado: i.resultado, retrasoMinutos: i.retrasoMinutos }]
      : [],
  );
}

test("una negativa con retraso llega al feed con sus minutos", () => {
  const feed = crearFeed();
  const registro = crearRegistroAcciones(feed);
  const accion = registro.proponer({
    type: "llamada_voz",
    targetElementId: "sub-01",
    destinatario: "jefe-brigada",
    mensaje: "Abandona el empalme y ve al hospital",
  });

  const cierre: CierreLlamada = {
    actionId: accion.id,
    resultado: "rechazado",
    retrasoMinutos: 40,
    compromiso: "Termina el empalme y sale después",
    resumen: "Ángel se niega: perdería 40 minutos de trabajo si se va ahora",
  };

  feed.publicar({
    kind: "resultado",
    elementId: accion.targetElementId,
    actionId: cierre.actionId,
    resultado: cierre.resultado,
    retrasoMinutos: cierre.retrasoMinutos,
    resumen: cierre.resumen,
  });

  assert.deepEqual(resultados(feed.desde(0)), [
    { actionId: accion.id, resultado: "rechazado", retrasoMinutos: 40 },
  ]);
});

test("un aceptado limpio no arrastra retraso", () => {
  const feed = crearFeed();
  feed.publicar({
    kind: "resultado",
    elementId: "hosp-01",
    actionId: "act-009",
    resultado: "aceptado",
    retrasoMinutos: null,
    resumen: "La responsable confirma el corte de 10 minutos",
  });
  assert.deepEqual(resultados(feed.desde(0)), [
    { actionId: "act-009", resultado: "aceptado", retrasoMinutos: null },
  ]);
});
