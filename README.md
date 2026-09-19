# SwarmUp

Agente de IA autónomo que gestiona una crisis en directo: un apagón en cascada en la Comunidad de Madrid. Un motor de decisión híbrido (reglas duras + LLM) criba las señales que importan, prioriza con los recursos que quedan, los despliega sobre el terreno y replantea la estrategia cuando la situación cambia. Proyecto para el reto HappyRobot de HackSpain 2026 — *"¿Puede la IA gestionar una crisis?"*.

## Arquitectura

Monorepo en TypeScript (npm workspaces):

```
/backend   → servidor Node: API REST + motor de decisión + RAG
/frontend  → app React + MapLibre GL: mapa de la crisis, feed del agente y control manual
/shared    → tipos, esquemas y catálogo de reglas duras compartidos
/data      → guion de eventos (JSON) e histórico RAG pre-cargado por tipo de elemento
/docs      → diseño, contrato de API y documentación del reto
```

### Cómo decide el agente

Tres capas por tick:

1. **Percepción** (determinista, ~1 ms) — filtra el ruido, deriva `status` y `severidad`, calcula la prioridad. Solo despierta al LLM si algo ha cambiado de verdad: un cruce de umbral, un ETA incumplido, un plazo superado o una inyección manual. El resto de ticks no gastan una llamada.
2. **Deliberación** (LLM, 8-30 s) — recibe el mundo, el catálogo de reglas, el histórico del tipo de sitio afectado y el plan en curso. Devuelve salida estructurada: qué descarta y por qué, objetivo, pasos y decisiones con su razonamiento.
3. **Validación** (determinista) — `validarAccion` veta lo que incumple las reglas duras y le devuelve el motivo al modelo para que lo corrija, hasta dos reintentos. Los rechazos se publican en el feed.

Si el LLM no responde a tiempo, el motor **degrada a la fórmula de prioridad determinista** y la simulación sigue. La demo nunca se congela.

- **LLM**: un proveedor con interfaz OpenAI-compatible ([Helmcode](https://helmcode.com), modelo `deepseek-v4-flash`). El proveedor es configuración, no código: se cambia en el `.env`.
- **Aprendizaje**: RAG con Chroma local, arrancado por el propio backend. El histórico se consulta por tipo de elemento y el agente cita los incidentes que aplican por su id.
- **Acciones reales**: ⚠️ pendiente. Las acciones `contactar` se deciden, se registran y salen en el feed, pero la integración con la API de HappyRobot todavía no está.

## Requisitos

- Node 24 (ver `.nvmrc`)
- Una clave de Helmcode (o de cualquier proveedor OpenAI-compatible)

## Puesta en marcha

```bash
npm install
cp .env.example .env   # rellena LLM_BASE_URL, LLM_API_KEY y LLM_MODEL
npm run dev
```

Y abre **http://localhost:5173**. Arrancan tres procesos:

| Puerto | Qué |
| ------ | --------------------------------------------------- |
| `5173` | Frontend (Vite, proxea `/api` al backend)           |
| `3001` | Backend: API, motor de decisión y simulación        |
| `8000` | Chroma (RAG) — lo levanta el backend, no hay que tocarlo |

Si ya hay un Chroma escuchando en su puerto, se reutiliza en vez de arrancar otro.

## Cómo se usa la demo

Todo desde la interfaz, sin `curl`:

- **Iniciar** el guion — botón en la cabecera. Son 300 s con cinco momentos clave.
- **Pausar / reanudar** — cabecera.
- **Inyectar eventos en vivo** — panel de inyección. Cruzar un umbral dispara una replanificación completa en el siguiente tick.

La primera deliberación **tarda entre 8 y 30 segundos**: las alarmas aparecen al instante en el feed y el razonamiento del agente llega después. No está colgado, está pensando.

## Scripts

| Comando             | Descripción                               |
| ------------------- | ----------------------------------------- |
| `npm run dev`       | Backend y frontend en modo desarrollo     |
| `npm run build`     | Build de los tres workspaces              |
| `npm run typecheck` | Typecheck estricto de los tres workspaces |
| `npm run test`      | Tests de todos los workspaces             |
| `npm run lint`      | Lint de todos los workspaces              |

## API

| Endpoint        | Método | Descripción                                        |
| --------------- | ------ | -------------------------------------------------- |
| `/api/topology` | GET    | Elementos afectados y recursos del escenario       |
| `/api/state`    | GET    | Foto del mundo: estado, sensores, posiciones       |
| `/api/agent`    | GET    | Plan actual, decisiones y acciones del agente      |
| `/api/feed`     | GET    | Log append-only con cursor `since`                 |
| `/api/control`  | POST   | Iniciar, reiniciar, pausar, reanudar e inyectar    |
| `/api/health`   | GET    | Healthcheck del backend                            |

El detalle completo en [`docs/CONTRACT.md`](docs/CONTRACT.md).

## Configuración

Todas las variables van en `.env` (raíz del repo, fuera de git). Ver [`.env.example`](.env.example): puerto, cadencia del tick, proveedor LLM (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_EMBEDDING_MODEL`), clave de HappyRobot y ajustes de Chroma.

El backend valida el `.env` al arrancar y no levanta si falta algo, indicando qué variable falla sin mostrar su valor.

## Documentación

- [`docs/DESIGN.md`](docs/DESIGN.md) — arquitectura y decisiones de diseño
- [`docs/CONTRACT.md`](docs/CONTRACT.md) — contrato de API y datos
- [`docs/RULES.md`](docs/RULES.md) — catálogo de reglas duras: umbrales, prioridad y reglas bloqueantes
- [`docs/Guía del Reto Happy Robot.md`](docs/Guía%20del%20Reto%20Happy%20Robot.md) — enunciado original del reto
- [`docs/Checklist Evaluación Reto Happy Robot.md`](docs/Checklist%20Evaluación%20Reto%20Happy%20Robot.md) — criterios de evaluación

## CI

GitHub Actions ejecuta `npm ci`, typecheck, build y lint en cada push a `main` y en cada PR (`.github/workflows/ci.yml`).
