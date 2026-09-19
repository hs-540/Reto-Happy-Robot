# SwarmUp

Agente de IA autónomo que gestiona una crisis en directo: un apagón en cascada en la Comunidad de Madrid. Un motor de decisión híbrido (reglas duras + LLM) prioriza acciones, reparte recursos limitados, notifica por voz y mensaje vía HappyRobot, y replantea la estrategia cuando la situación cambia. Proyecto para el reto HappyRobot de HackSpain 2026 — *"¿Puede la IA gestionar una crisis?"*.

## Arquitectura

Monorepo en TypeScript (npm workspaces):

```
/backend   → servidor Node: API REST + motor de decisión + integración HappyRobot y AI Gateways
/frontend  → app React + MapLibre GL: mapa de la crisis, feed del agente y control manual
/shared    → tipos y esquemas compartidos (Element, SensorEvent, Decision, Action)
/data      → guion de eventos (JSON) e histórico RAG pre-cargado por tipo de elemento
/docs      → diseño, contrato de API y documentación del reto
```

- **Motor de decisión**: reglas duras no negociables + LLM que razona dentro de esas reglas con salida estructurada (tool use). Tick cada 5-10 s; replanteamiento total ante cambios de severidad o fallos de ETA.
- **LLM**: Vercel AI Gateway (principal) con fallback a Cloudflare AI Gateway, ambos vía SDK OpenAI-compatible. Orden intercambiable con `LLM_GATEWAY_ORDER`.
- **Aprendizaje**: RAG con Chroma local; el histórico de incidentes se consulta por tipo de elemento (hospital, datacenter, subestación).
- **Acciones reales**: llamadas de voz y mensajes a través de la API de HappyRobot.

## Requisitos

- Node 24 (ver `.nvmrc`)
- Claves de Vercel AI Gateway, Cloudflare AI Gateway y HappyRobot

## Puesta en marcha

```bash
npm install
cp .env.example .env   # rellena los valores
npm run dev            # backend en :3001 + frontend en :5173
```

## Scripts

| Comando           | Descripción                                              |
| ----------------- | -------------------------------------------------------- |
| `npm run dev`     | Backend y frontend en modo desarrollo                    |
| `npm run build`   | Build de los tres workspaces                             |
| `npm run typecheck` | Typecheck estricto de backend y frontend               |
| `npm run test`    | Tests de todos los workspaces                            |
| `npm run lint`    | Lint de todos los workspaces                             |

## API

| Endpoint         | Método | Descripción                                     |
| ---------------- | ------ | ----------------------------------------------- |
| `/api/topology`  | GET    | Elementos afectados y recursos del escenario    |
| `/api/state`     | GET    | Estado actual de la simulación                  |
| `/api/feed`      | GET    | Log de decisiones y acciones (cursor `since`)   |
| `/api/control`   | POST   | Pausar/reanudar el motor y arrancar/resetear    |
| `/api/health`    | GET    | Healthcheck del backend                         |

El detalle completo en [`docs/CONTRACT.md`](docs/CONTRACT.md).

## Configuración

Todas las variables se definen en `.env` (raíz del repo, fuera de git). Ver [`.env.example`](.env.example): puerto, cadencia del tick, gateways LLM, clave de HappyRobot y ruta de Chroma.

## Documentación

- [`docs/DESIGN.md`](docs/DESIGN.md) — arquitectura y decisiones de diseño
- [`docs/CONTRACT.md`](docs/CONTRACT.md) — contrato de API y datos
- [`docs/RULES.md`](docs/RULES.md) — normas del equipo
- [`docs/Guía del Reto Happy Robot.md`](docs/Guía%20del%20Reto%20Happy%20Robot.md) — enunciado original del reto
- [`docs/Checklist Evaluación Reto Happy Robot.md`](docs/Checklist%20Evaluación%20Reto%20Happy%20Robot.md) — criterios de evaluación

## CI

GitHub Actions ejecuta `npm ci`, typecheck, build y lint en cada push a `main` y en cada PR (`.github/workflows/ci.yml`).
