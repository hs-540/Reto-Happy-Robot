# Diseño — Reto HappyRobot (HackSpain 2026)

## Contexto del reto

Construir un agente de IA autónomo capaz de gestionar una crisis que **cambia mientras el sistema corre**, respondiendo continuamente a:

- Qué información entrante importa realmente.
- Qué acción tiene prioridad.
- A quién notificar y en qué orden.
- Cómo repartir recursos limitados.
- Cuál es la siguiente acción concreta.
- Cuándo abandonar el plan actual por uno nuevo.

Evaluación en 3 bloques con igual peso: **Decision Quality**, **Execution**, **Supervision**.

## Escenario

- **Tipo de crisis**: apagón regional (blackout en cascada) en la **Comunidad de Madrid**.
- **Elementos afectados** (MVP): **datacenters, hospitales y subestaciones/nodos de red** — 1 sitio de cada tipo para el MVP, escalable a más si da tiempo.
- **Posibles extensiones futuras** (no MVP): torres de telecomunicaciones, fábricas, transporte público.
- **Dinámica del guion**: **guion fijo/scripted** para el MVP (línea base de eventos programados y cronometrados). Mejora futura si hay tiempo: modo **híbrido** con un botón para que el presentador inyecte eventos extra en directo.
- **Duración de la demo**: 4-5 minutos, con **5 momentos clave**:
  1. Apagón inicial en la subestación (origen) → el agente detecta y empieza a evaluar.
  2. Datacenter empieza a sobrecalentarse (UPS con batería limitada) → primera decisión de prioridad.
  3. Hospital pierde el generador de respaldo → conflicto de recursos → **llamada de voz en vivo** a un miembro del equipo.
  4. La cuadrilla enviada no cumple su ETA / empeora otro sitio → replanteamiento completo.
  5. Resolución: se repara la subestación, vuelve la energía, se cierra el incidente y se registra el resultado en el histórico RAG.

## Motor de decisión

- **Híbrido**: capa de **reglas duras** (restricciones no negociables, ej. límites de tiempo sin energía en hospitales) + **LLM** que razona y decide dentro de esas reglas, generando también la explicación en lenguaje natural de su priorización.
- **Replanteamiento completo** (abandonar el plan actual por uno nuevo) se dispara por cualquiera de:
  - Un evento hace que un elemento crítico cruce un **umbral de severidad**.
  - Una acción en marcha (ej. cuadrilla desplazada) **falla o no cumple su ETA**.
  - El resto de ticks son solo ajustes incrementales (reordenar colas, actualizar estados), sin regenerar la estrategia global.
- **Recursos limitados compartidos** entre los 3 tipos de elementos: **1 cuadrilla técnica móvil + 2 generadores portátiles** (cantidades escalan si aumenta el número de sitios).
- **Cadencia**:
  - Tick del motor de decisión: cada **5-10 segundos**.
  - Polling del frontend: cada **2 segundos**.

## LLM e infraestructura de IA

- **SDK de OpenAI** (interfaz OpenAI-compatible) apuntando a:
  - **Principal**: **Vercel AI Gateway** → modelo **GLM 5.3 Flash**.
  - **Fallback**: **Cloudflare AI Gateway** → modelo **DeepSeek V4 Flash**.
  - Orden intercambiable más adelante si conviene.
- **Salida estructurada**: el LLM decide entre un catálogo de acciones (llamar, mensajear, esperar, reasignar recurso) mediante tool use / structured output, validado por la capa de reglas antes de ejecutar.

## Aprendizaje entre ejecuciones (bonus)

- **RAG con embeddings reales**:
  - **Vector DB**: **Chroma local** (sin servicio externo, corre junto al backend).
  - **Embeddings**: generados vía el mismo AI Gateway que el LLM.
  - **Organización**: histórico segmentado en carpetas/colección por tipo de elemento (`hospital/`, `datacenter/`, `subestacion/`). Cuando la crisis afecta a un hospital, se recuperan los registros históricos de la colección de hospitales.
  - **Pre-carga**: **3-5 incidentes sintéticos** por tipo, redactados antes del evento, para que el agente ya tenga contexto histórico desde la primera ejecución en directo.

## Acciones reales (HappyRobot)

- **MVP**: **llamada de voz** + **mensaje/chat**.
- **Extensión futura**: tickets / email de escalado.
- **Destinatarios — enfoque mixto**:
  - Llamada de voz real a un **miembro del equipo actuando un rol** (técnico/responsable) en el momento de mayor tensión del guion (punto 3).
  - Mensajes/chat de fondo a **contactos de prueba fijos** para el resto de acciones secundarias.

## Supervisión e interfaz

- **Stack frontend**: **React + TypeScript + MapLibre GL**, con polling cada 2s.
- **Mapa**: marcadores por elemento (datacenter/hospital/subestación) coloreados por estado, sobre la Comunidad de Madrid.
- **Panel**: log de decisiones/acciones del agente, estado de sensores, recursos disponibles/asignados.
- **Intervención humana** (MVP):
  - **Pausar/reanudar** el motor de decisión.
  - **Confirmación antes de ejecutar** cualquier acción real contra HappyRobot (llamada/mensaje).
  - Extensión futura: anular manualmente una decisión y forzar otra prioridad.

## Stack e infraestructura del proyecto

- **Monorepo**, TypeScript en ambos lados:
  ```
  /backend   → servidor Node (API REST + motor de decisión + integración HappyRobot/gateways)
  /frontend  → app React + MapLibre
  /data      → guion de eventos (JSON), histórico RAG pre-cargado (carpetas por tipo)
  /shared    → tipos TypeScript compartidos (Element, SensorEvent, Decision, Action)
  ```
- **Ejecución durante la demo**: todo en **local** (portátil del equipo), sin despliegue en la nube, para minimizar puntos de fallo por red del venue. Sigue dependiendo de internet para los AI Gateways y HappyRobot (inevitable).

## Créditos de sponsors disponibles

- **Vercel**: AI Gateway credits ($50).
- **Cloudflare**: AI Gateway ($100).
- Quiver AI, Fal AI: no utilizados en este diseño (créditos disponibles si se necesitan para extensiones).
