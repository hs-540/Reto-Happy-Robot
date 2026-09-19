# Checklist — Reto Happy Robot (HackSpain 2026)

> Objetivos extraídos de `Guía del Reto Happy Robot.md` (requisitos de entrega y criterios de evaluación).

## Requisitos obligatorios de entrega

- [x] **Sistema agéntico** — decide y actúa por su cuenta (no chatbot pasivo) *(motor híbrido reglas+LLM, sin gate humano: `agente.ts` observa → delibera → ejecuta)*
- [x] **Escenario dinámico** — cambios continuos durante la ejecución *(tick + guion de eventos + inyecciones en vivo con replanificación)*
- [x] **Respuesta multi-paso** — cadena de acciones con objetivo cohesivo *(plan con pasos encadenados, `replanDe` enlaza cada replanificación)*
- [ ] **Interacción real** — integración con sistemas externos (llamadas, APIs, tickets) *(⚠️ pendiente: `contactar` se sella como ejecutada pero no llama a la API de HappyRobot)*
- [x] **Interfaz de usuario** — panel con estado, acciones del sistema e intervención *(mapa + feed + panel agente + panel de inyección + pausa)*

## 🧠 Decisión

- [x] Decide con sensatez **sin información completa** *(criba de señales: solo despierta al LLM si algo cambia de verdad)*
- [x] Prioriza correctamente bajo **urgencia múltiple** *(fórmula de prioridad determinista + validación de reglas duras)*
- [x] Se **adapta** a cambios situacionales en vivo *(cruces de umbral, ETA incumplidas, inyecciones → replan inmediato)*

## ⚡ Acción

- [x] Coordina **simultáneamente** personas, información y recursos *(asigna recursos y contacta en la misma deliberación, varias decisiones por plan)*
- [x] **Ejecuta de verdad** (no solo propone acciones) *(`asignar_recurso` mueve recursos y cambia el mundo; `contactar` queda registrada, sin ejecución real)*

## 👁 Supervisión

- [x] **Transparencia operacional** + intervención humana posible *(feed append-only con razonamiento, inyección manual, pausa/reinicio)*
- [x] Escenario y gestión **originales** *(apagón en cascada en la Comunidad de Madrid)*
- [x] **Aprendizaje iterativo** de ejecuciones previas *(RAG con Chroma: el agente cita incidentes históricos aplicables por id; histórico precargado, no generado de ejecuciones propias)*

## 🎁 Bonus / Presentación

- [x] **Aprendizaje** — análisis de ejecuciones previas para mejora continua (bonus) *(RAG sobre `data/history` por tipo de elemento, citado en el razonamiento)*
- [ ] **Demo pulida** — "la demo cuenta tanto como el sistema" *(pendiente de ensayar completa; la integración HappyRobot afecta al efecto "llamada real")*
