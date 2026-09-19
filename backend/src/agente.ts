import type {
  Action,
  AgentPlan,
  AgentView,
  AttentionState,
  Decision,
  ElementStatus,
  ElementView,
  CierreLlamada,
  HistoricoIncidente,
  Remedios,
  Reporte,
  StateView,
  Topologia,
} from "@swarmup/shared";
import { validarAccion } from "@swarmup/shared";
import type { RegistroAcciones } from "./control.js";
import type { ClienteHappyRobot } from "./happyrobot.js";
import type { ClienteLlm } from "./llm.js";
import type { EventoMundo, Mundo } from "./mundo.js";
import type { Feed } from "./feed.js";
import {
  SalidaAgenteSchema,
  construirMensajes,
  type AccionPropuesta,
  type SalidaAgente,
} from "./prompt.js";

/**
 * Reintentos ante acciones rechazadas por las reglas duras. Uno, no dos: cada
 * llamada cuesta 15-30s, así que tres intentos se comían el presupuesto entero
 * y garantizaban el fallback justo cuando el agente estaba corrigiéndose.
 */
const MAX_REINTENTOS = 1;

/**
 * Presupuesto total de una deliberación, reintentos incluidos; agotado, manda
 * el fallback determinista. Tiene que cubrir el peor caso realista con la
 * latencia medida del proveedor: una llamada larga (~19s) más un reintento
 * tras un rechazo de las reglas duras.
 */
const PRESUPUESTO_MS = 60_000;

/** Decisiones que se conservan para `/api/agent` */
const MAX_DECISIONES = 20;

export interface Agente {
  /** Un tick del motor. Decide si delibera; si lo hace, ejecuta lo que salga. */
  observar(estado: StateView, eventos: EventoMundo[]): Promise<void>;
  vista(): AgentView;
  /** Estado de atención derivado, que el contrato exige calcular en backend */
  atencion(elementId: string): ElementView["atencion"];
  /** Señal entrante en bruto; se acumula hasta la siguiente deliberación */
  encolarReporte(reporte: Reporte): void;
  /**
   * Resultado de una llamada real. Un rechazo o un retraso invalidan el ETA con
   * el que se hizo el plan, así que fuerzan replanificación en el próximo tick.
   */
  cerrarLlamada(cierre: CierreLlamada): void;
  reiniciar(): void;
}

export interface OpcionesAgente {
  mundo: Mundo;
  feed: Feed;
  llm: ClienteLlm;
  /** Registro de acciones reales: las sella como ejecutadas y las publica (#43, sin gate humano) */
  registroAcciones: RegistroAcciones;
  /** canal hacia el mundo real: llamadas y mensajes */
  happyrobot: ClienteHappyRobot;
  historico: HistoricoIncidente[];
  topologia: Topologia;
  remedios: Remedios;
  /** Segundo simulado actual */
  segundos: () => number;
}

function esperar(ms: number): Promise<never> {
  return new Promise((_, rechazar) =>
    setTimeout(() => rechazar(new Error("presupuesto de deliberación agotado")), ms),
  );
}

export function crearAgente(opciones: OpcionesAgente): Agente {
  const { mundo, feed, llm, registroAcciones, happyrobot, historico, topologia, remedios, segundos } =
    opciones;

  let plan: AgentPlan | null = null;
  let decisiones: Decision[] = [];
  /** acciones de comunicación ya ejecutadas, las más recientes primero */
  let acciones: Action[] = [];
  /** status del tick anterior, para detectar cruces de umbral */
  let statusPrevio = new Map<string, ElementStatus>();
  /**
   * Avisos ya enviados, por destinatario y texto. Con teléfonos reales, repetir
   * el mismo mensaje a la misma persona es llamarla dos veces para decirle lo
   * mismo: molesta y resta credibilidad. Si el mensaje cambia, sale de nuevo.
   */
  const avisosEnviados = new Set<string>();
  /** señales en bruto acumuladas desde la última deliberación */
  let reportesPendientes: Reporte[] = [];
  /** motivos extra inyectados desde fuera (resultados de llamadas) */
  let motivosExternos: string[] = [];
  /** una deliberación en vuelo dura más que un tick: no se solapan */
  let deliberando = false;
  let contador = 0;

  function nuevoId(prefijo: string): string {
    contador += 1;
    return `${prefijo}-${String(contador).padStart(3, "0")}`;
  }

  /* ─── Percepción: ¿ha cambiado algo que merezca pensar? ─────────────── */

  /**
   * Replanificar es ABANDONAR un plan que ya existía porque los hechos lo han
   * superado. Un cambio de status es el pan de cada tick y no basta: si todo se
   * marca como replan, la etiqueta deja de distinguir nada y se pierde el
   * momento que de verdad importa — la brigada incumpliendo su ETA.
   */
  const MOTIVOS_REPLAN = ["no cumple su ETA", "ha superado su límite", "La llamada"];

  function esReplan(motivos: string[]): boolean {
    if (plan === null) return false; // no hay plan que abandonar
    return motivos.some((m) => MOTIVOS_REPLAN.some((p) => m.includes(p)));
  }

  function motivosDeliberacion(estado: StateView, eventos: EventoMundo[]): string[] {
    const motivos: string[] = [];

    for (const ev of eventos) {
      if (ev.tipo === "eta_incumplida") {
        motivos.push(`${ev.recursoId} no cumple su ETA hacia ${ev.elementId}: el plan contaba con ello`);
      } else if (ev.tipo === "plazo_superado") {
        motivos.push(
          `${ev.elementId} lleva ${ev.minutosSinEnergia} min sin energía y ha superado su límite`,
        );
      }
      // `llegada` es ajuste incremental: no justifica regenerar la estrategia
    }

    for (const e of estado.elementos) {
      const antes = statusPrevio.get(e.id);
      if (antes !== undefined && antes !== e.status && e.status !== "normal") {
        motivos.push(`${e.id} pasa de ${antes} a ${e.status}`);
      }
    }

    // un rechazo o un retraso comunicado por teléfono invalida el ETA del plan
    motivos.push(...motivosExternos);
    motivosExternos = [];

    // arranque: hay crisis y todavía no hay plan
    if (plan === null && estado.elementos.some((e) => e.status === "critico" || e.status === "degradado")) {
      motivos.push("primera evaluación de la crisis: no hay plan");
    }

    return motivos;
  }

  /* ─── Fallback determinista: el agente degrada, nunca se congela ─────── */

  /** Contacto que responde de un sitio, para el aviso automático del fallback */
  function responsableDe(elementId: string): string | null {
    return remedios.contactos.find((c) => c.elementId === elementId)?.id ?? null;
  }

  function decidirPorReglas(estado: StateView, motivos: string[]): SalidaAgente {
    const contexto = mundo.contexto(estado.elementos);
    const ranking = mundo.prioridades(estado.elementos);
    const objetivo = ranking.find((p) => {
      const e = estado.elementos.find((x) => x.id === p.elementId);
      return e && e.status !== "normal" && e.status !== "resuelto";
    });

    if (!objetivo) {
      return {
        evaluacion: { descartados: [], accionables: [] },
        objetivo: "Sin incidencias activas: vigilancia",
        pasos: [],
        comunicaciones: [],
        decisiones: [],
      };
    }

    // Un recurso solo sirve si su remedio aplica a este tipo de sitio: mandar
    // una cisterna a un hospital sin luz es gastar el viaje y se ve fatal.
    const tipoObjetivo = estado.elementos.find((e) => e.id === objetivo.elementId)?.type;
    const libre = estado.recursos.find(
      (r) =>
        r.status === "disponible" &&
        remedios.remedios.some(
          (rem) =>
            rem.recurso === r.type &&
            tipoObjetivo !== undefined &&
            (rem.aplicableA as readonly string[]).includes(tipoObjetivo),
        ),
    );
    const accion: AccionPropuesta =
      libre &&
      validarAccion(
        { tipo: "asignar_recurso", elementId: objetivo.elementId, recursoId: libre.id },
        contexto,
      ).permitido
        ? {
            tipo: "asignar_recurso",
            elementId: objetivo.elementId,
            recursoId: libre.id,
            canal: null,
            destinatario: null,
            mensaje: `Despliegue de ${libre.id} sobre el sitio de mayor prioridad`,
          }
        : {
            tipo: "esperar",
            elementId: objetivo.elementId,
            recursoId: null,
            canal: null,
            destinatario: null,
            mensaje: "Sin recursos asignables ahora mismo",
          };

    return {
      evaluacion: { descartados: [], accionables: motivos },
      objetivo: `Modo degradado (sin LLM): atender ${objetivo.elementId} por prioridad de reglas`,
      pasos: [{ descripcion: accion.mensaje, elementId: objetivo.elementId }],
      // aun sin LLM se avisa al responsable: quedarse callado no es una opción
      comunicaciones: responsableDe(objetivo.elementId)
        ? [
            {
              destinatario: responsableDe(objetivo.elementId) as string,
              canal: "mensaje_chat" as const,
              elementId: objetivo.elementId,
              mensaje: `Incidencia activa en ${objetivo.elementId}. ${accion.mensaje}.`,
              motivo: "Aviso automático en modo degradado",
            },
          ]
        : [],
      decisiones: [
        {
          elementId: objetivo.elementId,
          prioridad: 1,
          razonamiento: `Fallback determinista: ${objetivo.elementId} encabeza la prioridad calculada (${objetivo.score}).`,
          citaHistorico: null,
          acciones: [accion],
        },
      ],
    };
  }

  /* ─── Deliberación: LLM con reintento contra las reglas duras ────────── */

  async function deliberar(estado: StateView, motivos: string[]): Promise<SalidaAgente> {
    const tiposImplicados = new Set(
      estado.elementos.filter((e) => e.status !== "normal").map((e) => e.type),
    );
    const ctx = {
      relojSimulacion: estado.relojSimulacion,
      elementos: estado.elementos,
      recursos: estado.recursos,
      sinEnergiaSegundos: (id: string) => mundo.sinEnergiaSegundos(id),
      prioridades: mundo.prioridades(estado.elementos),
      planActual: plan,
      historico: historico.filter((h) => tiposImplicados.has(h.tipo)),
      topologia,
      remedios,
      reportes: reportesPendientes,
      motivos,
    };

    // consumidos: la próxima deliberación solo verá lo que llegue a partir de ahora
    reportesPendientes = [];

    let rechazos: string[] = [];
    let ultima: SalidaAgente | null = null;

    for (let intento = 0; intento <= MAX_REINTENTOS; intento++) {
      const respuesta = await llm.estructurada(
        construirMensajes(ctx, rechazos),
        SalidaAgenteSchema,
        "decision_agente",
      );
      ultima = respuesta.datos;
      rechazos = recolectarRechazos(ultima, estado);
      if (rechazos.length === 0) return ultima;

      for (const motivo of rechazos) {
        feed.publicar({ kind: "sistema", mensaje: `Acción bloqueada por reglas duras — ${motivo}` });
      }
    }

    // agotados los reintentos: se descartan las acciones ilegales, el resto sigue
    if (!ultima) throw new Error("el LLM no devolvió ninguna propuesta");
    return {
      ...ultima,
      decisiones: ultima.decisiones.map((d) => ({
        ...d,
        acciones: d.acciones.filter((a) => esLegal(a, estado)),
      })),
    };
  }

  function esLegal(accion: AccionPropuesta, estado: StateView): boolean {
    return validarAccion(
      {
        tipo: accion.tipo,
        elementId: accion.elementId,
        recursoId: accion.recursoId ?? undefined,
      },
      mundo.contexto(estado.elementos),
    ).permitido;
  }

  function recolectarRechazos(salida: SalidaAgente, estado: StateView): string[] {
    const contexto = mundo.contexto(estado.elementos);
    const motivos: string[] = [];
    // Las comunicaciones son campo propio: se ejecutan siempre, aunque el
    // modelo no haya metido ninguna acción `contactar` dentro de una decisión.
    for (const c of salida.comunicaciones) {
      const huella = `${c.destinatario}|${c.mensaje.trim()}`;
      if (avisosEnviados.has(huella)) continue;
      const contacto = remedios.contactos.find((x) => x.id === c.destinatario);
      if (!contacto) {
        feed.publicar({
          kind: "sistema",
          mensaje: `Destinatario desconocido "${c.destinatario}": el aviso no sale`,
        });
        continue;
      }
      avisosEnviados.add(huella);
      const accion = registroAcciones.proponer({
        type: c.canal,
        targetElementId: anclarASitio(c.elementId, estado),
        destinatario: contacto.id,
        mensaje: c.mensaje,
      });
      acciones = [accion, ...acciones].slice(0, MAX_DECISIONES);
      happyrobot.contactar({
        actionId: accion.id,
        contacto,
        canal: c.canal,
        mensaje: c.mensaje,
        contexto: { elementId: accion.targetElementId, situacion: c.motivo },
      });
    }

    for (const d of salida.decisiones) {
      for (const a of d.acciones) {
        const veredicto = validarAccion(
          { tipo: a.tipo, elementId: a.elementId, recursoId: a.recursoId ?? undefined },
          contexto,
        );
        if (!veredicto.permitido) {
          motivos.push(`[${veredicto.regla}] ${a.tipo} sobre ${a.elementId}: ${veredicto.razon}`);
        }
      }
    }
    return motivos;
  }

  /* ─── Ejecución ──────────────────────────────────────────────────────── */

  /**
   * El LLM a veces usa `elementId` como campo libre y mete ahí un recurso o un
   * contacto. La decisión sigue siendo buena; lo que falla es la etiqueta. La
   * reanclamos al sitio del que realmente trata en vez de tirar la acción.
   */
  function anclarASitio(id: string, estado: StateView): string {
    if (estado.elementos.some((e) => e.id === id)) return id;
    const porRecurso = estado.recursos.find((r) => r.id === id)?.assignedElementId;
    if (porRecurso && estado.elementos.some((e) => e.id === porRecurso)) return porRecurso;
    const contacto = remedios.contactos.find((c) => c.id === id);
    if (contacto?.elementId && estado.elementos.some((e) => e.id === contacto.elementId)) {
      return contacto.elementId;
    }
    if (contacto?.recursoId) {
      const destino = estado.recursos.find((r) => r.id === contacto.recursoId)?.assignedElementId;
      if (destino) return destino;
    }
    // sin ancla posible: el sitio de mayor prioridad es el contexto más probable
    return mundo.prioridades(estado.elementos)[0]?.elementId ?? id;
  }

  function ejecutar(salida: SalidaAgente, estado: StateView, provocaReplan: boolean): void {
    const ahora = estado.relojSimulacion;

    if (salida.evaluacion.descartados.length > 0) {
      feed.publicar({
        kind: "sistema",
        mensaje: `Criba: ${salida.evaluacion.accionables.length} señales accionables, ${salida.evaluacion.descartados.length} descartadas (${salida.evaluacion.descartados.join("; ")})`,
      });
    }

    plan = {
      objetivo: salida.objetivo,
      pasos: salida.pasos.map((p, i) => ({
        id: `p${i + 1}`,
        descripcion: p.descripcion,
        elementId: p.elementId,
        completado: false,
      })),
      generadoEn: ahora,
      replanDe: plan === null ? null : (decisiones[0]?.id ?? null),
    };

    // Las comunicaciones son campo propio: se ejecutan siempre, aunque el
    // modelo no haya metido ninguna acción `contactar` dentro de una decisión.
    for (const c of salida.comunicaciones) {
      const huella = `${c.destinatario}|${c.mensaje.trim()}`;
      if (avisosEnviados.has(huella)) continue;
      const contacto = remedios.contactos.find((x) => x.id === c.destinatario);
      if (!contacto) {
        feed.publicar({
          kind: "sistema",
          mensaje: `Destinatario desconocido "${c.destinatario}": el aviso no sale`,
        });
        continue;
      }
      avisosEnviados.add(huella);
      const accion = registroAcciones.proponer({
        type: c.canal,
        targetElementId: anclarASitio(c.elementId, estado),
        destinatario: contacto.id,
        mensaje: c.mensaje,
      });
      acciones = [accion, ...acciones].slice(0, MAX_DECISIONES);
      happyrobot.contactar({
        actionId: accion.id,
        contacto,
        canal: c.canal,
        mensaje: c.mensaje,
        contexto: { elementId: accion.targetElementId, situacion: c.motivo },
      });
    }

    for (const d of salida.decisiones) {
      const decision: Decision = {
        id: nuevoId("dec"),
        timestamp: ahora,
        elementId: anclarASitio(d.elementId, estado),
        prioridad: d.prioridad,
        razonamiento: d.citaHistorico
          ? `${d.razonamiento} [histórico: ${d.citaHistorico}]`
          : d.razonamiento,
        provocaReplan,
        acciones: [],
      };

      for (const a of d.acciones) {
        if (a.tipo === "asignar_recurso" && a.recursoId) {
          const resultado = mundo.asignar(a.recursoId, a.elementId, segundos());
          feed.publicar({
            kind: "sistema",
            mensaje: resultado.ok
              ? `${a.recursoId} → ${a.elementId}, ETA ${resultado.etaSegundos}s`
              : `No se pudo asignar ${a.recursoId}: ${resultado.razon}`,
          });
        } else if (a.tipo === "contactar" && a.canal) {
          // Sin gate humano (#43): el registro la sella como ejecutada y la publica
          const accion = registroAcciones.proponer({
            type: a.canal,
            targetElementId: anclarASitio(a.elementId, estado),
            destinatario: a.destinatario ?? undefined,
            mensaje: a.mensaje,
          });
          acciones = [accion, ...acciones].slice(0, MAX_DECISIONES);
          decision.acciones.push(accion);

          // Aquí el sistema sale del portátil: suena un teléfono de verdad.
          const contacto = remedios.contactos.find((c) => c.id === a.destinatario);
          if (contacto) {
            happyrobot.contactar({
              actionId: accion.id,
              contacto,
              canal: a.canal,
              mensaje: a.mensaje,
              contexto: { elementId: accion.targetElementId, situacion: d.razonamiento },
            });
          } else {
            feed.publicar({
              kind: "sistema",
              mensaje: `Destinatario desconocido "${a.destinatario}": el mensaje queda registrado sin enviar`,
            });
          }
        }
      }

      decisiones = [decision, ...decisiones].slice(0, MAX_DECISIONES);
      feed.publicar({
        kind: "decision",
        elementId: decision.elementId,
        decisionId: decision.id,
        prioridad: decision.prioridad,
        razonamiento: decision.razonamiento,
        provocaReplan: decision.provocaReplan,
      });
    }
  }

  /* ─── API pública ────────────────────────────────────────────────────── */

  return {
    async observar(estado, eventos): Promise<void> {
      const motivos = motivosDeliberacion(estado, eventos);
      statusPrevio = new Map(estado.elementos.map((e) => [e.id, e.status]));

      if (motivos.length === 0 || deliberando || estado.pausado) return;

      deliberando = true;
      try {
        let salida: SalidaAgente;
        try {
          salida = await Promise.race([deliberar(estado, motivos), esperar(PRESUPUESTO_MS)]);
        } catch (err) {
          const causa = err instanceof Error ? err.message : String(err);
          console.error(`[agente] deliberación fallida (${causa}); fallback a reglas`);
          feed.publicar({
            kind: "sistema",
            mensaje: "LLM no disponible: el motor sigue en modo reglas deterministas",
          });
          salida = decidirPorReglas(estado, motivos);
        }
        ejecutar(salida, estado, esReplan(motivos));
      } finally {
        deliberando = false;
      }
    },

    vista(): AgentView {
      return {
        tick: 0,
        pausado: false,
        planActual: plan,
        decisiones,
        acciones,
      };
    },

    atencion(elementId): ElementView["atencion"] {
      const recurso = mundo.recursos().find((r) => r.assignedElementId === elementId);
      const decision = decisiones.find((d) => d.elementId === elementId);
      let estado: AttentionState = "sin_atencion";
      // un recurso en ruta ya cubre el sitio: distinguirlo evita que el agente
      // retenga recursos "por si acaso" sobre algo que ya tiene respuesta
      if (recurso) estado = recurso.status === "en_transito" ? "recurso_en_camino" : "recurso_asignado";
      else if (decision) estado = "analizando";
      return {
        estado,
        recursoId: recurso?.id ?? null,
        decisionActivaId: decision?.id ?? null,
      };
    },


    encolarReporte(reporte): void {
      reportesPendientes.push(reporte);
    },

    cerrarLlamada(cierre): void {
      const accion = acciones.find((a) => a.id === cierre.actionId);
      feed.publicar({
        kind: "resultado",
        elementId: accion?.targetElementId ?? null,
        actionId: cierre.actionId,
        resultado: cierre.resultado,
        retrasoMinutos: cierre.retrasoMinutos,
        resumen: cierre.resumen,
      });
      if (cierre.resultado === "aceptado") return;
      const retraso =
        cierre.retrasoMinutos === null ? "sin plazo concreto" : `${cierre.retrasoMinutos} min de retraso`;
      motivosExternos.push(
        `La llamada ${cierre.actionId} terminó en "${cierre.resultado}" (${retraso}): ${cierre.resumen}. El plan contaba con un plazo que ya no se cumple.`,
      );
    },

    reiniciar(): void {
      plan = null;
      decisiones = [];
      acciones = [];
      statusPrevio = new Map();
      avisosEnviados.clear();
      reportesPendientes = [];
      motivosExternos = [];
      contador = 0;
    },
  };
}
