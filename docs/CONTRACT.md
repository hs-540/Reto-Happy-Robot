# Contrato de API y datos — Reto HappyRobot

Fuente de verdad de la comunicación backend ↔ frontend. Los tipos viven en
`shared/src/index.ts`; este documento los ilustra con payloads de ejemplo.

Regla: si cambia una ruta o un payload, se cambia primero `shared`, compila, y
luego se actualiza este documento. El tracker de issues no manda.

## Endpoints

| Ruta | Método | Propósito | Poll |
|---|---|---|---|
| `/api/topology` | GET | Elementos + recursos base + metadatos del guion | 1 vez al cargar |
| `/api/state` | GET | Mundo + recursos (foto actual) | 2s |
| `/api/agent` | GET | Plan actual, decisiones vivas, acciones | 2s |
| `/api/feed?since=<seq>` | GET | Log append-only (`alarma`/`decision`/`accion`/`sistema`) | 1-2s |
| `/api/control` | POST | `pausar`/`reanudar`/`confirmar`/`rechazar`/`inyectar` | — |
| `/api/health` | GET | Estado de conexión | 5s |

## Reglas de oro

1. Cursor monotónico `seq`, **nunca timestamps** para `since`. Evita duplicados y huecos.
2. Todo ítem del feed lleva `elementId` y, si aplica, `decisionId`/`actionId`. Permite correlacionar mapa ↔ agente.
3. `/api/topology` y `/api/state` devuelven **foto completa**, nunca diffs.
4. `severidad`, `status` y `atencion` los calcula el **backend**. El front no deriva estado crítico.
5. `atencion.estado` es derivado (acción viva o recurso asignado), no lo setea el LLM.
6. El feed se consume como **acumulador por `seq`** (merge + dedup). Así se puede pasar de polling a SSE sin tocar la UI.

## GET /api/topology

```json
{
  "crisis": {
    "titulo": "Apagón regional — Getafe, Comunidad de Madrid",
    "duracionSegundos": 300,
    "momentos": [
      { "atSeconds": 0, "titulo": "Apagón inicial en la subestación" },
      { "atSeconds": 40, "titulo": "Datacenter se sobrecalienta" },
      { "atSeconds": 90, "titulo": "Hospital pierde el generador" },
      { "atSeconds": 150, "titulo": "ETA incumplida: replanteamiento" },
      { "atSeconds": 240, "titulo": "Subestación reparada" }
    ]
  },
  "elementos": [
    { "id": "sub-01", "type": "subestacion", "name": "Subestación Getafe-Sur", "lat": 40.3057, "lng": -3.7327, "criticidad": 70 },
    { "id": "dc-01", "type": "datacenter", "name": "CPD Metropolitano Getafe", "lat": 40.295, "lng": -3.72, "criticidad": 60 },
    { "id": "hosp-01", "type": "hospital", "name": "Hospital Regional Getafe-Sur", "lat": 40.31, "lng": -3.71, "criticidad": 95 }
  ],
  "recursos": [
    { "id": "cuadrilla-1", "type": "cuadrilla", "lat": 40.302, "lng": -3.722 },
    { "id": "generador-1", "type": "generador", "lat": 40.302, "lng": -3.722 },
    { "id": "generador-2", "type": "generador", "lat": 40.302, "lng": -3.722 }
  ]
}
```

## GET /api/state

Foto completa del mundo. Se reemplaza entera en cada poll.

```json
{
  "tick": 42,
  "pausado": false,
  "relojSimulacion": "2026-09-18T10:03:30.000Z",
  "ultimoSeq": 17,
  "elementos": [
    {
      "id": "hosp-01",
      "type": "hospital",
      "name": "Hospital Regional Getafe-Sur",
      "lat": 40.31,
      "lng": -3.71,
      "status": "critico",
      "severidad": 85,
      "sensores": { "bateria_generador": 18, "tension_red": 12 },
      "atencion": {
        "estado": "recurso_asignado",
        "recursoId": "generador-2",
        "decisionActivaId": "dec-004"
      },
      "actualizadoEn": "2026-09-18T10:03:30.000Z"
    }
  ],
  "recursos": [
    {
      "id": "cuadrilla-1",
      "type": "cuadrilla",
      "status": "en_transito",
      "assignedElementId": "dc-01",
      "lat": 40.299,
      "lng": -3.717
    }
  ]
}
```

`status`: `normal` → `degradado` → `critico` → `resuelto`.
`atencion.estado`: `sin_atencion` | `analizando` | `recurso_asignado` | `resuelto`.
La asignación aparece en los dos lados (`element.atencion.recursoId` y `resource.assignedElementId`); el backend la calcula una vez.

## GET /api/agent

```json
{
  "tick": 42,
  "pausado": false,
  "planActual": {
    "objetivo": "Estabilizar hospital antes de que se agote el generador",
    "pasos": [
      { "id": "p1", "descripcion": "Asignar generador-2 a hosp-01", "elementId": "hosp-01", "completado": true },
      { "id": "p2", "descripcion": "Avisar a responsable del hospital", "elementId": "hosp-01", "completado": false }
    ],
    "generadoEn": "2026-09-18T10:03:10.000Z",
    "replanDe": "dec-003"
  },
  "decisiones": [
    {
      "id": "dec-004",
      "timestamp": "2026-09-18T10:03:10.000Z",
      "elementId": "hosp-01",
      "prioridad": 1,
      "razonamiento": "El hospital tiene criticidad 95 y solo 18% de batería. El datacenter puede esperar 5 min.",
      "provocaReplan": true,
      "acciones": [
        {
          "id": "act-007",
          "type": "llamada_voz",
          "targetElementId": "hosp-01",
          "destinatario": "responsable_hospital",
          "status": "propuesta",
          "mensaje": "Cortaremos suministro 10 min para conectar el generador portátil.",
          "timestamp": "2026-09-18T10:03:10.000Z"
        }
      ]
    }
  ],
  "acciones": []
}
```

`Decision.provocaReplan` marca los ticks que regeneran el plan global. El resto son ajustes incrementales.
`Action.status` nace en `propuesta`; solo pasa a `confirmada` → `ejecutada` tras confirmación humana.

## GET /api/feed?since=<seq>

Devuelve solo lo nuevo. El front acumula y deduplica por `seq`.

```json
{
  "items": [
    { "seq": 18, "ts": "2026-09-18T10:03:40.000Z", "kind": "alarma", "elementId": "dc-01", "metric": "temperatura", "value": 48, "severidad": 70 },
    { "seq": 19, "ts": "2026-09-18T10:03:41.000Z", "kind": "decision", "elementId": "dc-01", "decisionId": "dec-005", "prioridad": 2, "razonamiento": "Reasigno recursos al datacenter…", "provocaReplan": false },
    { "seq": 20, "ts": "2026-09-18T10:03:42.000Z", "kind": "accion", "elementId": "dc-01", "actionId": "act-008", "tipo": "mensaje_chat", "estado": "ejecutada", "mensaje": "Cierre preventivo de pasillos calientes." },
    { "seq": 21, "ts": "2026-09-18T10:03:43.000Z", "kind": "sistema", "mensaje": "Replanificación completa: cuadrilla no cumple ETA." }
  ],
  "ultimoSeq": 21
}
```

Sin `since` → devuelve el feed completo (útil para debug).

## POST /api/control

```json
{ "accion": "confirmar", "id": "act-007" }
```

```json
{ "accion": "inyectar", "payload": { "elementId": "dc-01", "metric": "temperatura", "value": 55, "severidad": 80 } }
```

Respuesta:

```json
{ "ok": true }
```

`accion`: `pausar` | `reanudar` | `confirmar` | `rechazar` | `inyectar`.
`pausar` congela el reloj de simulación y detiene el tick del LLM.
`confirmar`/`rechazar` requieren `id` (actionId). `inyectar` requiere `payload`.

## GET /api/health

```json
{ "status": "ok", "tick": 42, "pausado": false }
```

## Correlación mapa ↔ agente

| Elemento UI | Fuente | Campo de enlace |
|---|---|---|
| Marcador, color | `/api/state` | `elementos[].status` |
| Movimiento de recurso | `/api/state` | `recursos[].lat/lng` |
| Texto de decisión | `/api/agent` | `decisiones[].razonamiento` |
| Botón confirmar | `/api/agent` | `acciones[].id` → `POST /api/control` |
| Ticker / historial | `/api/feed` | `items[].elementId`, `decisionId`, `actionId` |
