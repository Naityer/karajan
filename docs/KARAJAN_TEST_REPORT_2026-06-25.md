# KARAJAN - Reporte de prueba del router

Fecha: 2026-06-25  
Ejecucion: `karajan_trials_20260625_195604`  
API local: `http://127.0.0.1:8001`  
Backend usado: `simulated`

## Objetivo

Probar la skill/router de KARAJAN como si existiera una jerarquia real de decision con un agente padre y varios workers. La prueba valida clasificacion, asignacion por nivel, delegacion, trazabilidad, skills sugeridas, metricas de monitorizacion y comportamiento ante tareas criticas.

No se usaron proveedores reales ni API keys. La ejecucion se hizo en modo simulado para evitar coste y aislar la logica del arnes.

## Jerarquia esperada

| Rol | Modelo | Niveles asignados | Funcion esperada |
| --- | --- | --- | --- |
| Agent / padre | OpenAI GPT | N4, N5 | Decide tareas complejas o criticas, activa revision humana y coordina delegacion. |
| Worker | Google Gemini | N2, N3 | Ejecuta tareas intermedias de producto, frontend, analisis y documentacion. |
| Backup / worker barato | Groq | N1 | Resuelve tareas simples o de baja ambiguedad con coste bajo. |
| Worker local disponible | Ollama | Sin nivel fijo | Alternativa local futura para pruebas sin coste. |
| Validator futuro | Claude / OpenAI Codex CLI | Sin nivel fijo | Validacion, revision de codigo y control de calidad cuando se habilite ejecucion real. |

## Pruebas ejecutadas

Fuente de resultados: [data/trial_reports/karajan_trials_20260625_195604.json](/C:/Users/tiand/Desktop/karajan/data/trial_reports/karajan_trials_20260625_195604.json)

| Caso | Task ID | Estado | Nivel | Score | Modelo recomendado | Skills |
| --- | --- | --- | --- | ---: | --- | --- |
| N1 simple / Groq | `tsk_68937c6cd4a9` | `completed` | `level_1_simple` | 0.77 | `cheap_model` | `ponytail` |
| N2/N3 intermedia / Gemini | `tsk_6bf17805c220` | `completed` | `level_2_moderate` | 2.19 | `cheap_or_medium_model` | `frontend-builder`, `repo-analyzer`, `ponytail` |
| N4/N5 critica / Padre | `tsk_b74bc84e41af` | `delegated` | `level_4_complex` | 4.10 | `strong_model` | `security-review`, `backend-builder`, `repo-analyzer`, `ponytail` |

## Ejecuciones simuladas

| Subtarea | Estado | Backend | Modelo usado | Coste est. | Latencia |
| --- | --- | --- | --- | ---: | ---: |
| `sub_001` | `completed` | `simulated` | `simulated:cheap_model` | 0.0004 | 217 ms |
| `sub_001` | `completed` | `simulated` | `simulated:cheap_or_medium_model` | 0.0020 | 357 ms |
| `sub_002` | `completed` | `simulated` | `simulated:medium_model` | 0.0075 | 724 ms |

La tarea critica quedo en estado `delegated` y no ejecuto subtareas finales porque activo puerta de revision humana. Este comportamiento es correcto para N4/N5 si la politica exige control humano.

## KPIs observados

Valores acumulados actuales de `/metrics` despues de la nueva pasada:

| Metrica | Valor |
| --- | ---: |
| Tareas totales | 6 |
| Subtareas totales | 10 |
| Tareas delegadas | 6 |
| Revision humana requerida | 2 |
| Score medio | 2.35 |
| Coste estimado total | 0.1183 USD |

Distribucion por nivel:

| Nivel | Total |
| --- | ---: |
| `level_1_simple` | 2 |
| `level_2_moderate` | 2 |
| `level_4_complex` | 2 |

Distribucion por modelo recomendado:

| Modelo | Total |
| --- | ---: |
| `cheap_model` | 2 |
| `cheap_or_medium_model` | 2 |
| `strong_model` | 2 |

## Observabilidad

Estado de `/observability`:

| Campo | Valor |
| --- | ---: |
| Estado global | `warning` |
| Nodos observados | 1 |
| Nodos sanos | 1 |
| Tareas activas | 2 |
| Tareas bloqueadas | 2 |
| Coste acumulado observado | 0.2366 USD |
| Latencia media | 815 ms |

Uso de modelos observado:

| Modelo | Llamadas | Coste est. | Latencia |
| --- | ---: | ---: | ---: |
| `simulated:strong_model_with_human_review` | 1 | 0.0625 | 1774 ms |
| `simulated:strong_model` | 1 | 0.0360 | 1337 ms |
| `simulated:medium_model` | 2 | 0.0150 | 724 ms |
| `simulated:cheap_or_medium_model` | 2 | 0.0040 | 357 ms |
| `simulated:cheap_model` | 2 | 0.0008 | 217 ms |

## Resultado funcional

La clasificacion base funciona. El sistema distingue correctamente una tarea simple, una tarea intermedia y una tarea critica.

La politica de coste y complejidad tambien funciona en la capa simulada: las tareas simples caen en modelo barato, las intermedias en modelo barato/medio o medio, y las criticas en modelo fuerte con revision humana.

El monitor ya recibe eventos suficientes para reconstruir flujo operativo: `prompt_received`, `task_classified`, `task_delegated` y `validation`.

## Bugs y riesgos detectados

### P1 - Persistencia del diagrama corrupta

`data/routing_layout.json` se lee como contenido nulo. Esto es un riesgo alto porque la jerarquia visual puede no sobrevivir bien a reinicios o puede depender del estado del navegador. Hay que endurecer la escritura atomica del layout.

Recomendacion:
- Escribir el layout en archivo temporal.
- Validar JSON antes de reemplazar el definitivo.
- Mantener una copia `.bak`.
- Si el JSON esta corrupto, arrancar con layout por defecto y mostrar aviso en UI.

### P1 - Observabilidad no refleja aun nodos reales de la jerarquia

`/observability` agrupa todo en un unico nodo `entity-parent`. La UI ya permite representar OpenAI/Gemini/Groq, pero la metrica backend todavia no modela cada entidad como nodo operativo independiente.

Recomendacion:
- Persistir `node_id`, `role`, `model_id`, `provider`, `levels`, `skills` y `parent_id` por ejecucion.
- Emitir eventos por nodo real, no solo por task global.
- Separar metrica de Agent, Worker, Backup, Validator y Skill.

### P1 - La delegacion visual y la delegacion backend no estan conectadas del todo

La jerarquia visual dice N1 -> Groq, N2/N3 -> Gemini, N4/N5 -> Agent. El backend simulado recomienda tiers (`cheap_model`, `medium_model`, `strong_model`), pero no siempre demuestra que haya elegido explicitamente la entidad del diagrama.

Recomendacion:
- Crear un `DecisionGraphResolver` que traduzca nivel + rol + disponibilidad a entidad concreta.
- Guardar en cada tarea `assigned_entity_id` y `assigned_entity_name`.
- Mostrar esa asignacion en Monitor y en detalle de tarea.

### P2 - El estado global queda en `warning`

El warning es razonable porque hay tareas bloqueadas por revision humana, pero ahora no distingue entre bloqueo esperado y error operacional.

Recomendacion:
- Separar `blocked_by_policy` de `blocked_by_error`.
- Usar estados: `healthy`, `policy_waiting`, `degraded`, `error`.

### P2 - Coste duplicado o dificil de interpretar

`/metrics` muestra 0.1183 USD y `/observability` muestra 0.2366 USD. Puede ser acumulacion historica, doble contabilizacion por eventos o scopes diferentes.

Recomendacion:
- Definir scopes: `run_cost`, `task_cost`, `lifetime_cost`.
- Mostrar el scope en la UI.
- Evitar sumar clasificacion y delegacion dos veces si representan la misma ejecucion.

### P2 - Falta trazabilidad de skills

El sistema asigna skills como `ponytail`, `frontend-builder`, `repo-analyzer`, `security-review` y `backend-builder`, pero no queda claro si fueron solo etiquetas, capacidades candidatas o ejecuciones reales.

Recomendacion:
- Guardar `skill_state`: `suggested`, `selected`, `executed`, `skipped`, `failed`.
- Mostrar razon de seleccion.
- Registrar inputs/outputs resumidos de cada skill.

### P3 - Monitor: siguiente capa visual pendiente

El Monitor ya empezo a simplificarse con panel principal y lateral, pero todavia falta completar:
- Burbujas/nodos de modelos implicados como selector principal.
- Panel lateral contextual por nodo seleccionado.
- Una sola linea temporal unificada para evitar duplicar "flujo" y "auditoria".
- Vista de graficas para coste, latencia, delegacion, errores y uso por skill.

## Mejoras recomendadas para la siguiente iteracion

1. Reparar persistencia atomica de `routing_layout.json`.
2. Conectar el diagrama visual con el resolver real de delegacion.
3. Convertir cada entidad del diagrama en nodo observable.
4. Crear reporte por ejecucion con `run_id` propio, no solo acumulado global.
5. Separar revision humana esperada de error real.
6. Unificar timeline de Monitor y filtrar por nodo/modelo/skill.
7. Anadir tests para:
   - exclusividad de niveles por entidad,
   - carga/recuperacion de layout corrupto,
   - asignacion de entidad por nivel,
   - observabilidad por nodo,
   - coherencia entre coste de metrics y observability.

## Conclusion

La prueba confirma que el harness base funciona: clasifica, pondera, recomienda modelo, delega subtareas simuladas, registra eventos y bloquea tareas criticas con revision humana.

El siguiente salto importante no es estetico: es hacer que el diagrama sea fuente real de decision. Ahora mismo la UI representa la jerarquia, pero el backend todavia necesita convertir esa jerarquia en una resolucion auditable por entidad.
