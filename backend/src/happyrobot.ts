import type { CierreLlamada, Contacto, ResultadoLlamada } from "@swarmup/shared";

/**
 * Una llamada real tarda ~1 min en resolverse. El motor no la espera: la
 * dispara y sigue decidiendo; el resultado vuelve por `alCerrar` y entra como
 * trigger de replanificación.
 */
export interface PeticionContacto {
  actionId: string;
  contacto: Contacto;
  canal: "llamada_voz" | "mensaje_chat";
  /** lo que hay que transmitir, ya redactado para este destinatario */
  mensaje: string;
  /** contexto del incidente que el agente de voz usa para improvisar */
  contexto: {
    elementId: string;
    situacion: string;
  };
}

export interface ClienteHappyRobot {
  /** Dispara el contacto. No espera: el resultado llega por el callback. */
  contactar(peticion: PeticionContacto): void;
  readonly modo: "real" | "simulado";
}

export interface OpcionesHappyRobot {
  apiKey: string;
  baseUrl: string;
  alCerrar: (cierre: CierreLlamada) => void;
}

const TIMEOUT_MS = 90_000;

/** Sin credencial real no se puede llamar a nadie; el modo simulado lo suple */
export function credencialUsable(apiKey: string): boolean {
  return apiKey.trim().length > 0 && apiKey.trim().toUpperCase() !== "PENDIENTE";
}

/* ─── Cliente real ───────────────────────────────────────────────────────
 * Endpoint documentado: POST {baseUrl}/api/v1/dial/outbound con la API key de
 * Settings > Profile. El resto de la documentación está tras login, así que el
 * shape exacto del cuerpo y de la respuesta hay que confirmarlo contra su
 * referencia antes de fiarse: si cambia, cambia SOLO esta función.
 */
function crearClienteReal(opciones: OpcionesHappyRobot): ClienteHappyRobot {
  const { apiKey, baseUrl, alCerrar } = opciones;

  return {
    modo: "real",
    contactar(peticion) {
      const cuerpo = {
        phone: peticion.contacto.telefono ?? undefined,
        // contexto dinámico que el agente de voz recibe para improvisar
        context: {
          rol: peticion.contacto.rol,
          nombre: peticion.contacto.nombre,
          mensaje: peticion.mensaje,
          sitio: peticion.contexto.elementId,
          situacion: peticion.contexto.situacion,
        },
      };

      void fetch(`${baseUrl}/api/v1/dial/outbound`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HappyRobot respondió ${res.status}`);
          // El resultado definitivo llega por webhook a /api/llamada/resultado
          // cuando el agente de voz cuelga. Esto solo confirma que salió.
          console.log(`[happyrobot] llamada lanzada a ${peticion.contacto.id}`);
        })
        .catch((err: unknown) => {
          const causa = err instanceof Error ? err.message : String(err);
          console.error(`[happyrobot] no se pudo contactar a ${peticion.contacto.id}: ${causa}`);
          // Un fallo de la plataforma no puede congelar la crisis: se cierra
          // como "no contesta" y el agente replanifica con esa información.
          alCerrar({
            actionId: peticion.actionId,
            resultado: "no_contesta",
            retrasoMinutos: null,
            compromiso: null,
            resumen: `No se pudo establecer el contacto con ${peticion.contacto.nombre}: ${causa}`,
          });
        });
    },
  };
}

/* ─── Cliente simulado ───────────────────────────────────────────────────
 * Sin credencial, la cadena completa sigue ejercitándose: el agente contacta,
 * alguien responde y el resultado vuelve como trigger. Las respuestas son
 * deterministas y guionizadas para que la demo tenga su momento de tensión.
 */
interface GuionRespuesta {
  resultado: ResultadoLlamada;
  retrasoMinutos: number | null;
  compromiso: string | null;
  resumen: string;
}

/** Cuánto tarda en "responder" cada canal, en ms reales */
const LATENCIA_SIMULADA: Record<PeticionContacto["canal"], number> = {
  llamada_voz: 8_000,
  mensaje_chat: 2_000,
};

function respuestaDe(contacto: Contacto, intento: number): GuionRespuesta {
  // El jefe de brigada se niega la primera vez, y con razón: abandonar un
  // empalme a medias cuesta más de lo que ahorra (hist-sub-003).
  if (contacto.id === "jefe-brigada" && intento === 1) {
    return {
      resultado: "rechazado",
      retrasoMinutos: 22,
      compromiso: "Termina el empalme y sale después",
      resumen: `${contacto.nombre} se niega a abandonar la reparación a medias: retomarla costaría 22 minutos más de los que se ahorran`,
    };
  }
  if (contacto.id === "jefe-brigada") {
    return {
      resultado: "aceptado_con_retraso",
      retrasoMinutos: 8,
      compromiso: "Deja el empalme asegurado y sale en 8 minutos",
      resumen: `${contacto.nombre} acepta tras asegurar el empalme; sale en 8 minutos`,
    };
  }
  if (contacto.id === "conductor-cisterna") {
    return {
      resultado: "aceptado_con_retraso",
      retrasoMinutos: 6,
      compromiso: "Desvía la ruta por el perímetro",
      resumen: `${contacto.nombre} acepta el desvío; el acceso habitual está cortado y pierde 6 minutos`,
    };
  }
  return {
    resultado: "aceptado",
    retrasoMinutos: null,
    compromiso: "Confirma y ejecuta",
    resumen: `${contacto.nombre} confirma la instrucción`,
  };
}

function crearClienteSimulado(alCerrar: OpcionesHappyRobot["alCerrar"]): ClienteHappyRobot {
  const intentos = new Map<string, number>();

  return {
    modo: "simulado",
    contactar(peticion) {
      const intento = (intentos.get(peticion.contacto.id) ?? 0) + 1;
      intentos.set(peticion.contacto.id, intento);
      const respuesta = respuestaDe(peticion.contacto, intento);

      console.log(
        `[happyrobot:simulado] ${peticion.canal} a ${peticion.contacto.id} → ${respuesta.resultado}`,
      );
      setTimeout(() => {
        alCerrar({ actionId: peticion.actionId, ...respuesta });
      }, LATENCIA_SIMULADA[peticion.canal]);
    },
  };
}

/**
 * Elige cliente según haya credencial usable. Arrancar sin llamadas reales es
 * peor que arrancar con llamadas simuladas: lo segundo deja la cadena completa
 * en pie y convierte la integración en un cambio de variable de entorno.
 */
export function crearClienteHappyRobot(opciones: OpcionesHappyRobot): ClienteHappyRobot {
  if (credencialUsable(opciones.apiKey)) return crearClienteReal(opciones);
  console.warn(
    "[happyrobot] sin credencial usable: las comunicaciones se simulan y la demo sigue en pie",
  );
  return crearClienteSimulado(opciones.alCerrar);
}
