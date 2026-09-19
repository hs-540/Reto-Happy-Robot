# Catálogo de reglas duras

> **Fuente única de verdad**: `shared/src/rules.json` (datos) + `shared/src/rules.ts` (capa tipada y validación).
> Cualquier número que aplique el motor o el agente vive aquí. **No hay umbrales mágicos repartidos por el código.**
>
> Estado: **cerrado** (acuerdo A + B, issue #26). Cambiar un valor requiere PR y actualizar este documento.
> Depende de la semántica de `status`/`severidad`/`atencion` del contrato (#18).

## Cómo se consume

| Consumidor | Qué usa |
| --- | --- |
| Derivación de estado (#19) | `derivarStatus`, `derivarStatusMetrica`, `derivarStatusElemento` |
| Capa de reglas del motor (#10/#20) | `validarAccion`, `REGLAS_BLOQUEANTES`, `TRIGGERS_REPLAN` |
| **Agente (LLM)** | `REGLAS_PARA_AGENTE` — el JSON completo, inyectado tal cual en el system prompt, para que las decisiones y planes de acción respeten las mismas reglas y pesos |
| Prioridad de decisiones | `calcularPrioridad` + `ORDEN_PRIORIDAD` |

Flujo de toda acción del agente: **el LLM propone** (tool use / structured output) → **`validarAccion` valida contra las reglas bloqueantes** → si viola una regla se rechaza con su `id` y se devuelve al LLM → si no, **se ejecuta directamente, sin gate humano de confirmación** (#42), y se registra en la `Decision`.

---

## 1. Umbrales de severidad → status

`severidad` es 0–100 (más alto = peor). Cortes **incluidos** (>=):

| Rango | Status |
| --- | --- |
| `severidad >= 60` | `critico` |
| `30 <= severidad < 60` | `degradado` |
| `severidad < 30` | `normal` |
| `tension_red >= 90` durante **60 s** estables | `resuelto` |

- El status final de un elemento es **el peor** entre la severidad del último evento y sus métricas crudas (`derivarStatusElemento`).
- **No se declara `resuelto` con un único tick bueno**: exige 60 s de estabilidad con `tension_red >= 90` (lección de `hist-sub-002`, restauración parcial que generó falsa sensación de resolución).

## 2. Umbrales por métrica

Cortes incluidos. `direccion = bajo` → peor cuanto más bajo el valor; `direccion = alto` → peor cuanto más alto.

| Métrica | Dirección | `degradado` | `critico` |
| --- | --- | --- | --- |
| `tension_red` (%) | bajo | ≤ 85 | ≤ 50 |
| `carga_ups` (%) | bajo | ≤ 50 | ≤ 15 |
| `bateria_generador` (%) | bajo | ≤ 60 | ≤ 20 |
| `temperatura` (°C) | alto | ≥ 40 | ≥ 45 |
| `cobertura_red` (%) | bajo | ≤ 80 | ≤ 50 |

Estos umbrales crudos **elevan el status aunque la severidad del evento sea baja** (p. ej. `temperatura 41` con `severidad 55` → al menos `degradado`).

## 3. Límites temporales no negociables (minutos sin energía)

"Sin energía" = sin red **y sin respaldo fiable**. Al superar el límite del hospital se activa la regla bloqueante `hospital-plazo-energia`.

| Tipo de sitio | Máx. minutos sin energía |
| --- | --- |
| **hospital** | **8** |
| datacenter | 12 |
| subestacion | 20 |

### Umbral de UPS (cuándo una regla es bloqueante para el LLM)

| Condición | Consecuencia |
| --- | --- |
| `carga_ups < 15` | **Prohibido `esperar`**: hay que asignar recurso o escalar (`hist-dc-002`: UPS agotada mientras se esperaba refuerzo) |
| `carga_ups < 10` | Emergencia: activación inmediata de respaldo |
| `bateria_generador < 20` | Batería crítica: priorizar despacho del generador |

## 4. Restricciones de recursos

Capacidad total compartida del escenario: **1 cuadrilla + 2 generadores**.

- **Exclusión mutua**: un recurso atiende a **un elemento a la vez**. Un recurso en `asignado` o `en_transito` no puede reasignarse (regla bloqueante `sin-doble-asignacion`).
- **Al liberar un recurso** pasa a `disponible` y puede reasignarse en el siguiente tick; la liberación es un **ajuste incremental**, no dispara replanteamiento.
- Asignar a un recurso inexistente o no disponible se rechaza con la razón explícita (`libéralo antes de reasignar`).

## 5. Orden de prioridad (quién gana y por qué)

**Orden de tipos**: `hospital` > `subestacion` > `datacenter`. Motivo: riesgo vital > origen de la cascada (arreglarla restaura a todos) > pérdida de servicio. Coincide con la `criticidad` del contrato (95 / 70 / 60 en el guion).

### Fórmula de prioridad numérica

```
prioridad = 0.5 · criticidad
          + pesoStatus        (critico 60 · degradado 20 · normal/resuelto 0)
          + pesoTipo          (hospital 30 · subestacion 20 · datacenter 10)
          + 2 · min(minutosSinEnergia, 15)
```

Ejemplo del guion: hospital `critico` con 10 min sin energía → `47.5 + 60 + 30 + 20 = 157.5`; datacenter `degradado` sin pérdida de energía → `60`. Los pesos viven en `prioridad` de `rules.json` y el LLM los recibe en su prompt para ordenar sus planes.

## 6. Reglas bloqueantes para el LLM

El LLM **no puede** proponer una acción que las viole; la capa de reglas la rechaza antes de ejecutar:

| id | Regla |
| --- | --- |
| `sin-doble-asignacion` | Un recurso solo atiende a un elemento a la vez; reasignar exige liberar primero. |
| `hospital-prioridad-energia` | Mientras un hospital esté `critico` y sin respaldo de energía, los generadores solo pueden asignarse a él. |
| `hospital-plazo-energia` | Si un hospital supera su límite de minutos sin energía, solo se permite actuar sobre él o sobre la subestación de origen (si está `critico`). |
| `ups-critica-actuar` | Con `carga_ups` por debajo del umbral de actuación (15) está prohibido esperar: hay que asignar recurso o escalar. |

Notas de aplicación:

- `contactar` **nunca** se bloquea (comunicar no consume recursos físicos).
- Cuando dos reglas bloqueantes aplican, gana la **más estricta** (p. ej. con hospital `critico` sin respaldo, un generador no puede ir a la subestación aunque el hospital haya superado su plazo: manda `hospital-prioridad-energia`).

## 7. Triggers de replanificación

Disparan **replanteamiento completo** (abandonar el plan actual), no solo ajuste incremental:

1. Un evento hace que un elemento crítico **cruce un umbral de severidad**.
2. Una acción en marcha **falla o no cumple su ETA**.
3. Un hospital **supera su límite de minutos sin energía**.

El resto de ticks (5–10 s) son solo ajustes incrementales: reordenar colas por `calcularPrioridad`, actualizar estados, reasignar recursos liberados.
