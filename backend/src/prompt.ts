import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { z } from "zod";
import type {
  AgentPlan,
  ElementView,
  HistoricoIncidente,
  Remedios,
  Reporte,
  ResourceView,
  Topologia,
} from "@swarmup/shared";
import { REGLAS_PARA_AGENTE } from "@swarmup/shared";

/* ─── Salida estructurada del LLM ───────────────────────────────────────
 * Todos los campos son obligatorios y los opcionales van como `nullable`:
 * es lo que exige el structured output de la interfaz OpenAI-compatible.
 */

export const AccionPropuestaSchema = z.object({
  tipo: z.enum(["asignar_recurso", "contactar", "esperar"]),
  /** id de un SITIO de la lista (sub-01, hosp-01…). Nunca un recurso ni un contacto */
  elementId: z.string(),
  /** obligatorio si tipo === "asignar_recurso"; null en el resto */
  recursoId: z.string().nullable(),
  /** obligatorio si tipo === "contactar"; null en el resto */
  canal: z.enum(["llamada_voz", "mensaje_chat"]).nullable(),
  /** rol destinatario: responsable_hospital, jefe_cuadrilla, operador_cpd… */
  destinatario: z.string().nullable(),
  /** para `contactar` es lo que se dice; para el resto, qué se hace y por qué */
  mensaje: z.string(),
});

/**
 * Las comunicaciones son un campo propio y obligatorio, no una acción opcional
 * dentro de una decisión. Pedidas en prosa se caían siempre: el modelo se
 * centraba en repartir recursos y el aviso se quedaba escrito en un paso del
 * plan, sin salir de su cabeza. Como campo requerido, lo rellena.
 */
export const ComunicacionSchema = z.object({
  /** id de la lista de CONTACTOS: jefe-brigada, responsable-hospital… */
  destinatario: z.string(),
  canal: z.enum(["llamada_voz", "mensaje_chat"]),
  /** sitio del que trata el aviso */
  elementId: z.string(),
  /** el texto que se le dice, ya redactado para ESTA persona */
  mensaje: z.string(),
  /** por qué esta persona necesita saberlo ahora */
  motivo: z.string(),
});

export const SalidaAgenteSchema = z.object({
  evaluacion: z.object({
    /** señales entrantes que no cambian nada, y por qué */
    descartados: z.array(z.string()),
    /** señales que sí obligan a actuar */
    accionables: z.array(z.string()),
  }),
  objetivo: z.string(),
  pasos: z.array(
    z.object({ descripcion: z.string(), elementId: z.string().nullable() }),
  ),
  /** a quién avisas en esta deliberación; vacío solo si de verdad no hay nadie */
  comunicaciones: z.array(ComunicacionSchema),
  decisiones: z.array(
    z.object({
      /** id de un SITIO de la lista. Nunca un recurso ni un contacto */
      elementId: z.string(),
      /** 1 = lo más urgente */
      prioridad: z.number(),
      /** dos frases como mucho: el dato que manda y la conclusión */
      razonamiento: z.string(),
      /** id de un incidente histórico que justifica la decisión, o null */
      citaHistorico: z.string().nullable(),
      acciones: z.array(AccionPropuestaSchema),
    }),
  ),
});

export type AccionPropuesta = z.infer<typeof AccionPropuestaSchema>;
export type Comunicacion = z.infer<typeof ComunicacionSchema>;
export type SalidaAgente = z.infer<typeof SalidaAgenteSchema>;

/* ─── Construcción del prompt ─────────────────────────────────────────── */

/**
 * El catálogo en prosa compacta. Volcar `JSON.stringify(REGLAS_PARA_AGENTE)`
 * metía sus comentarios internos y su anidamiento en CADA llamada, y era el
 * bloque que más engordaba el prompt — y con él la latencia.
 */
function resumirReglas(): string {
  const r = REGLAS_PARA_AGENTE;
  const metricas = Object.entries(r.umbralesMetrica)
    .filter(([k]) => !k.startsWith("$"))
    .map(([m, u]) => `${m} ${u.direccion === "bajo" ? "peor cuanto menor" : "peor cuanto mayor"}: degradado ${u.degradado}, critico ${u.critico}`)
    .join("; ");
  const limites = Object.entries(r.limitesSinEnergiaMin)
    .filter(([k]) => !k.startsWith("$"))
    .map(([t, m]) => `${t} ${m}min`)
    .join(", ");
  const pesos = Object.entries(r.prioridad.pesoTipo)
    .map(([t, p]) => `${t} ${p}`)
    .join(", ");
  const bloqueantes = r.reglasBloqueantes.map((b) => `  [${b.id}] ${b.regla}`).join("\n");
  return [
    `Severidad: >=${r.severidad.umbralCritico} critico, >=${r.severidad.umbralDegradado} degradado.`,
    `Umbrales por métrica — ${metricas}.`,
    `Máximo sin energía por tipo — ${limites}.`,
    `UPS: por debajo de ${r.ups.actuar}% está prohibido esperar; ${r.ups.emergencia}% es emergencia.`,
    `Prioridad = 0.5*criticidad + peso(status) + peso(tipo) + 2*min(minutosSinEnergia,15). Pesos de tipo: ${pesos}.`,
    "REGLAS BLOQUEANTES (proponer algo que las viole se rechaza):",
    bloqueantes,
  ].join("\n");
}

const SISTEMA = `Eres el coordinador autónomo de una crisis por apagón regional en la Comunidad de Madrid.

Gestionas sitios críticos (hospital, subestación, datacenter) con recursos LIMITADOS y compartidos.
Decides tú: nadie te va a pedir permiso ni te va a corregir entre decisiones.

TU TRABAJO EN CADA DELIBERACIÓN
1. Separa la señal del ruido. Recibes SEÑALES SIN PROCESAR de redes sociales, llamadas al
   112, prensa y equipos en campo. La mayoría no cambia nada: son quejas, duplicados, avisos
   ya obsoletos o sensores averiados con lecturas físicamente imposibles. Descártalos sin
   contemplaciones y di por qué. Pero LEE TODAS: de vez en cuando, entre cincuenta mensajes
   irrelevantes, hay uno que describe un riesgo vital que ningún sensor va a reportarte.
   Encontrarlo es la parte de tu trabajo que nadie más puede hacer.
2. Prioriza con los medios QUE QUEDAN, no con los que harían falta.
3. Decide acciones concretas. "Monitorizar la situación" no es una acción.
3b. SÉ BREVE. Decide sobre los 3 o 4 sitios que de verdad cambian algo en este momento,
   no sobre los seis: un sitio estable y cubierto no necesita una decisión propia. Y cada
   "razonamiento" son DOS FRASES como mucho, por debajo de 240 caracteres: el dato que
   manda y la conclusión. Nada de recapitular el estado ni repetir lo que ya dijiste en
   otra decisión. Quien te lee está gestionando una emergencia y tiene cuatro minutos.
3c. Escribe en castellano correcto, CON TILDES. Esto se proyecta en una pantalla: "energia"
   o "reparacion" sin tilde se ven mal. Y no escribas nombres de campo en la prosa: para
   citar el histórico está "citaHistorico", no hace falta nombrarlo dentro del texto.
4. COMUNICA — campo "comunicaciones", obligatorio. Coordinar es hablar con gente, no solo
   mover camiones. Si hay UN SOLO sitio critico o degradado, ese campo NO puede ir vacío:
   alguien tiene que enterarse. Piensa quién sufre la situación o quién ejecuta lo que has
   decidido, y escríbele. Cuesta cero recursos y es la mitad de tu trabajo. Si un sitio está
   critico o degradado, o si una acción depende de alguien, EMITE una acción "contactar"
   con su canal, su destinatario de la lista de CONTACTOS y el mensaje ya redactado.
   - Un paso del plan NO es una comunicación. Escribir "avisar al hospital" o "solicitar
     confirmación al jefe de brigada" como paso del plan no avisa a nadie: no sale de tu
     cabeza. Si quieres que alguien se entere, la acción "contactar" es el único camino.
   - "elementId" es SIEMPRE el id de un sitio de la lista de SITIOS (sub-01, hosp-01,
     dc-01, torre-01, gas-01, cruce-01). Nunca metas ahí el id de un recurso ni de un
     contacto: para decir a quién llamas está "destinatario", y el sitio es aquel del que
     trata la decisión. Una llamada al jefe de brigada sobre la subestación es
     elementId "sub-01" con destinatario "jefe-brigada".
   - Cada destinatario necesita algo distinto. A la responsable del hospital le das plazos
     e instrucciones operativas; al operador del CPD, datos técnicos secos; a una ciudadana
     preocupada, lenguaje llano y un plazo concreto; al jefe de brigada, una orden con su
     porqué. El mismo hecho se cuenta de tres maneras distintas según quién escucha.
5. Si la mejor decisión es no mover nada, usa "esperar" Y JUSTIFÍCALO. Un agente que explica
   por qué no actúa vale más que uno que actúa por inercia.

GESTIÓN DEL INVENTARIO — LA CRISIS NO HA TERMINADO
- NO gastes todos tus recursos en el primer incidente. La situación sigue empeorando y lo peor
  casi nunca ha pasado todavía. Cada recurso que comprometes deja de estar disponible.
- Asigna el MÍNIMO que resuelve cada situación. Un sitio necesita normalmente un recurso, no tres:
  mandar dos generadores al mismo destino no lo arregla el doble de rápido.
- RESERVA al menos un generador mientras haya un hospital que no esté ya cubierto, aunque ahora
  mismo esté estable. El hospital es quien menos tiempo aguanta sin energía de todos los sitios,
  y cuando cae, cae rápido.
- Antes de comprometer tu último recurso libre, pregúntate qué harías si el siguiente sitio en
  caer fuera el hospital. Si la respuesta es "nada", no lo comprometas.

CÓMO RAZONAS
- Tienes un mapa de DEPENDENCIAS y un catálogo de REMEDIOS. No son sugerencias: son cómo
  está cableada la realidad. Un remedio que no aparece ahí no existe, y si un remedio
  declara un requisito, sin cumplirlo no sirve de nada gastarlo.
- Usa las dependencias para calcular cobertura: arreglar un nodo del que cuelgan cuatro
  sitios vale más que atender uno solo, aunque ese uno puntúe más alto.
- Cada sitio te dice si está YA CUBIERTO. Un recurso en ruta cuenta como cubierto: no
  mandes un segundo recurso a lo mismo ni retengas nada "por si acaso" sobre un sitio que
  ya tiene respuesta en camino. Ese recurso retenido le hace falta al siguiente en caer.
- Un rechazo de las reglas NO es permanente: describe el estado de AHORA. En cuanto cambie
  la condición que lo causó, reevalúa. No arrastres un veto viejo como si siguiera vigente.
- Los recursos tienen coste temporal: desplazarlos tarda, y mientras van no están en otro sitio.
- Piensa en acoplamientos, no solo en rankings. Reparar la subestación de origen puede
  restaurar a varios sitios a la vez; moverla a mitad de trabajo puede perderlo todo.
- El histórico son errores que ya se cometieron. Si uno aplica, cítalo por su id en
  "citaHistorico" y actúa en consecuencia.
- La prioridad numérica que recibes es una PISTA calculada por reglas, no una orden.
  Si tienes una razón mejor, discrepa y explícala en tu razonamiento.

LÍMITES NO NEGOCIABLES
Tus acciones se validan contra reglas duras antes de ejecutarse. Si propones algo que las
viola, se rechaza y te lo devuelvo con el motivo para que lo corrijas. El catálogo completo
de umbrales, pesos y reglas bloqueantes va abajo en JSON.

CATÁLOGO DE REGLAS
${resumirReglas()}`;

const ATENCION: Record<string, string> = {
  sin_atencion: "SIN CUBRIR",
  analizando: "en análisis, sin recurso comprometido",
  recurso_en_camino: "YA CUBIERTO: recurso en ruta",
  recurso_asignado: "YA CUBIERTO: recurso desplegado",
  resuelto: "resuelto",
};

function lineaElemento(e: ElementView, sinEnergiaSeg: number, prioridad: number): string {
  const sensores = Object.entries(e.sensores)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const energia =
    sinEnergiaSeg > 0 ? ` SIN ENERGÍA desde hace ${Math.floor(sinEnergiaSeg / 60)}m${Math.floor(sinEnergiaSeg % 60)}s` : "";
  const recurso = e.atencion.recursoId ? ` (${e.atencion.recursoId})` : "";
  const atencion = `${ATENCION[e.atencion.estado] ?? e.atencion.estado}${recurso}`;
  return `- ${e.id} (${e.type}, "${e.name}") status=${e.status} severidad=${e.severidad} prioridad=${prioridad}${energia}\n    ${atencion}\n    sensores: ${sensores || "sin lecturas"}`;
}

function lineaRecurso(r: ResourceView): string {
  const destino = r.assignedElementId ? ` → ${r.assignedElementId}` : "";
  return `- ${r.id} (${r.type}) ${r.status}${destino}`;
}

function lineaTopologia(a: Topologia["aristas"][number]): string {
  const destino = a.a === "*" ? "todo el escenario" : a.a;
  return `- ${a.de} --${a.tipo}--> ${destino}${a.nota ? `\n    ${a.nota}` : ""}`;
}

function lineaRemedio(r: Remedios["remedios"][number]): string {
  const req = r.requiere ? ` REQUIERE: ${r.requiere}.` : "";
  return `- ${r.recurso} resuelve "${r.resuelve}" en ${r.aplicableA.join("/")} — ${r.minutos} min.${req}\n    ${r.efecto}`;
}

function lineaContacto(c: Remedios["contactos"][number]): string {
  const ambito = c.recursoId ? ` dirige ${c.recursoId}` : c.elementId ? ` responde de ${c.elementId}` : "";
  return `- ${c.id}: ${c.nombre}, ${c.rol}.${ambito}${c.$nota ? ` ${c.$nota}` : ""}`;
}

function lineaReporte(r: Reporte): string {
  return `- [${r.fuente}]${r.elementId ? ` (${r.elementId})` : ""} ${r.texto}`;
}

function lineaHistorico(h: HistoricoIncidente): string {
  return `- [${h.id}] ${h.titulo}\n    ${h.resumen}\n    Aprendizaje: ${h.resultado}`;
}

export interface ContextoAgente {
  relojSimulacion: string;
  elementos: ElementView[];
  recursos: ResourceView[];
  sinEnergiaSegundos: (elementId: string) => number;
  prioridades: { elementId: string; score: number }[];
  planActual: AgentPlan | null;
  /** incidentes históricos de los tipos de elemento implicados */
  historico: HistoricoIncidente[];
  /** hechos físicos: qué depende de qué */
  topologia: Topologia;
  /** hechos físicos: qué recurso arregla qué, y a quién se puede llamar */
  remedios: Remedios;
  /** señales en bruto llegadas desde la última deliberación, la mayoría ruido */
  reportes: Reporte[];
  /** por qué se ha disparado esta deliberación */
  motivos: string[];
}

export function construirMensajes(
  ctx: ContextoAgente,
  rechazos: string[] = [],
): ChatCompletionMessageParam[] {
  const prioridadDe = new Map(ctx.prioridades.map((p) => [p.elementId, p.score]));

  const partes = [
    `RELOJ DE LA CRISIS: ${ctx.relojSimulacion}`,
    "",
    "POR QUÉ DELIBERAS AHORA:",
    ...ctx.motivos.map((m) => `- ${m}`),
    "",
    "SITIOS (prioridad = pista calculada por reglas, mayor = más urgente):",
    ...ctx.elementos.map((e) =>
      lineaElemento(e, ctx.sinEnergiaSegundos(e.id), prioridadDe.get(e.id) ?? 0),
    ),
    "",
    "RECURSOS DISPONIBLES — esto es todo lo que tienes:",
    ...ctx.recursos.map(lineaRecurso),
    "",
    "DEPENDENCIAS (cómo está cableado el escenario):",
    ...ctx.topologia.aristas.map(lineaTopologia),
    "",
    "REMEDIOS (qué arregla qué; nada fuera de esta lista existe):",
    ...ctx.remedios.remedios.map(lineaRemedio),
    "",
    "CONTACTOS (a quién puedes llamar o escribir, con el rol que tiene):",
    ...ctx.remedios.contactos.map(lineaContacto),
  ];

  if (ctx.reportes.length > 0) {
    partes.push(
      "",
      `SEÑALES SIN PROCESAR (${ctx.reportes.length} desde tu última deliberación) — críbalas:`,
      ...ctx.reportes.map(lineaReporte),
    );
  }

  if (ctx.historico.length > 0) {
    partes.push("", "INCIDENTES PASADOS DE ESTOS TIPOS DE SITIO:", ...ctx.historico.map(lineaHistorico));
  }

  if (ctx.planActual) {
    partes.push(
      "",
      `PLAN EN CURSO: ${ctx.planActual.objetivo}`,
      ...ctx.planActual.pasos.map((p) => `- [${p.completado ? "x" : " "}] ${p.descripcion}`),
      "",
      "Si el plan sigue siendo bueno, mantenlo y ajusta. Si los hechos lo han superado, abandónalo y haz otro.",
    );
  }

  const mensajes: ChatCompletionMessageParam[] = [
    { role: "system", content: SISTEMA },
    { role: "user", content: partes.join("\n") },
  ];

  if (rechazos.length > 0) {
    mensajes.push({
      role: "user",
      content: [
        "Tu propuesta anterior violaba reglas duras y fue RECHAZADA:",
        ...rechazos.map((r) => `- ${r}`),
        "",
        "Corrige esas acciones y devuelve la decisión completa de nuevo.",
      ].join("\n"),
    });
  }

  return mensajes;
}
