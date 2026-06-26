# KARAJAN Role Model

Este documento define el contrato de roles para el diagrama de decisión de KARAJAN. La regla principal es simple:

```text
Agent gobierna la estructura. Worker ejecuta. El resto apoya, valida, recuerda o monitoriza.
```

## Resumen Operativo Para Agentes

Usa esta tabla como lectura rápida antes de modificar el diagrama:

| Nivel | Etiquetas | Restricción | Puede poseer N1-N5 | Regla mental |
| --- | --- | --- | --- | --- |
| `R0` | `Agent` | Único rol de autoridad global. Solo debe existir un Agent activo. | Sí | Decide, clasifica, planifica, enruta y puede delegar. |
| `R1` | `Worker`, `Backup` | Roles primarios de ejecución. Mutuamente excluyentes con `Agent` y entre sí. | Sí | Ejecuta o queda en reserva; no gobierna la jerarquía. |
| `R2` | `Guardian`, `Validator` | Etiquetas auxiliares. Se pueden combinar como etiquetas, pero no convierten el nodo en dueño de niveles. | No | Critica, apoya o valida; no reclama complejidad. |
| `R3` | `Memory`, `Monitor` | Etiquetas de estado/observabilidad. No ejecutan negocio ni reasignan. | No | Recuerda o vigila; informa al Agent. |

Regla de interfaz:

```text
role = rol primario compatible con el backend.
role_tags = etiquetas visibles tipo multiselect.
capabilities = etiquetas de capacidad visibles dentro del mismo selector Rol.
```

El multiselect de la pantalla Decisión permite varias etiquetas, pero las ordena por restricción:

1. Primero debe haber un rol primario (`Agent`, `Worker` o `Backup`).
2. `Agent`, `Worker` y `Backup` se sustituyen entre sí; no se apilan.
3. `Guardian`, `Validator`, `Memory` y `Monitor` pueden añadirse como etiquetas auxiliares.
4. Solo el rol primario decide si el nodo puede reclamar niveles `N1-N5`.
5. `Classifier`, `Planner`, `Router`, `Reallocator`, `Aggregator`, `Policy` y `Recovery` aparecen en el mismo selector visual, pero se guardan como `capabilities`, no como `role_tags`.
6. Las capacidades de Agent solo se muestran cuando el rol primario activo es `Agent`.

`Classifier`, `Planner` y `Router` no son nodos obligatorios. En el MVP viven como capacidades internas fijas del `Agent` y solo deben separarse como nodos cuando la complejidad, la carga o la necesidad de trazabilidad lo justifique.

## Roles Visibles

Estos roles sí pueden asignarse visualmente a una entidad del diagrama:

| Rol | Función | Puede asumir niveles N1-N5 |
| --- | --- | --- |
| `Agent` | Nodo padre/orquestador. Recibe objetivos, clasifica, planifica, enruta, delega y agrega. | Sí |
| `Worker` | Nodo ejecutor. Realiza tareas concretas asignadas por el `Agent`. | Sí |
| `Backup` | Nodo de reserva. Permanece en standby y puede asumir `Agent` si falla el principal. | Sí, como fallback |
| `Guardian` | Nodo auxiliar asociado a un `Worker` para apoyarlo, criticarlo o revisarlo. | No |
| `Validator` | Nodo que valida salidas parciales o finales producidas por otros nodos. | No |
| `Memory` | Nodo encargado de estado, checkpoints y contexto. | No |
| `Monitor` | Nodo que vigila salud, timeouts, errores, disponibilidad y saturación. | No |

En la interfaz, la propiedad `role` conserva compatibilidad con el layout anterior:

| Valor persistido | Rol mostrado |
| --- | --- |
| `parent` | `Agent` |
| `child` | `Worker` |
| `backup` | `Backup` |
| `guardian` | `Guardian` |
| `validator` | `Validator` |
| `memory` | `Memory` |
| `monitor` | `Monitor` |

## Capacidades Internas

Estas capacidades no tienen por qué ser nodos independientes. En la interfaz aparecen como etiquetas dentro del selector `Rol`, pero su significado operativo sigue siendo de capacidad:

| Capacidad | Vive normalmente en | Cuándo separarla |
| --- | --- | --- |
| `Classifier` | `Agent` | Muchas categorías, reglas complejas o routing avanzado. |
| `Planner` | `Agent` | Plan con muchas fases, dependencias o subtareas. |
| `Router` | `Agent` | Muchos workers, prioridades, carga, fallback o costes distintos. |
| `Aggregator` | `Agent` | Varias respuestas paralelas que deben fusionarse. |
| `Policy` | `Agent` / `Monitor` | Permisos, límites, coste, riesgo o reglas críticas. |
| `Recovery` | `Agent` / `Backup` / `Monitor` como trigger | Reintentos, timeouts o recuperación compleja. |
| `Critic` | `Guardian` / `Validator` | Revisión crítica fuerte antes de aprobar. |

## Reallocator

> **Estado de implementación (2026-06):** `Reallocator` es hoy un concepto de
> planificación y una etiqueta de capacidad seleccionable en el diagrama de
> decisión. **No existe un motor en tiempo de ejecución** que reasigne roles,
> tareas o conexiones automáticamente; las acciones de abajo describen el
> contrato previsto, no comportamiento activo. Se implementará cuando un flujo
> concreto de failover/rebalanceo lo requiera. Hasta entonces queda documentado
> pero inerte por diseño (decisión P2, YAGNI).

`Reallocator` es una capacidad avanzada exclusiva del `Agent`.

```text
Solo un Agent con Reallocator activo puede reasignar roles globales, tareas, prioridades o relaciones.
```

No es un rol primario independiente. En la UI se selecciona como etiqueta de capacidad dentro de `Rol`, pero no se asigna a `Worker`, `Guardian`, `Validator`, `Memory`, `Monitor` ni `Backup` en standby. Un `Backup` solo puede usar `Reallocator` después de ser promovido formalmente a `Agent` activo.

Acciones permitidas por `Agent[Reallocator]`:

| Acción | Descripción |
| --- | --- |
| `reassign_task` | Mover una tarea de un `Worker` a otro. |
| `reassign_role` | Cambiar el rol de un nodo si la estructura es inválida o ineficiente. |
| `repair_hierarchy` | Corregir relaciones inválidas entre nodos. |
| `promote_node` | Elevar temporalmente un nodo, por ejemplo `Backup -> Agent`. |
| `degrade_node` | Retirar responsabilidades a un nodo saturado o fallido. |
| `activate_backup` | Transferir control al `Backup` cuando el `Agent` falla. |
| `absorb_capability` | Reabsorber `Classifier`, `Planner` o `Router` si sobran como nodos. |
| `separate_capability` | Separar capacidades internas si el `Agent` está sobrecargado. |
| `update_priority` | Reordenar ejecución entre nodos. |
| `repair_connection` | Reparar enlaces rotos o incompatibles. |

El orden de decisión recomendado es:

1. Reparar invalidez estructural.
2. Recuperar ejecución.
3. Optimizar eficiencia.
4. Mejorar calidad.

## Compatibilidad

Reglas duras:

| Regla | Motivo |
| --- | --- |
| `Worker + Agent` es incompatible salvo promoción explícita. | Mezcla ejecución con gobierno y rompe trazabilidad. |
| `Guardian` no valida al mismo nodo que está apoyando si ambos son la misma entidad. | No hay revisión independiente. |
| `Validator` no valida su propia salida. | Evita falsa validación. |
| `Backup` no está activo a la vez que el `Agent` principal. | Debe ser standby hasta fallo, timeout o saturación. |
| `Memory` no ejecuta tareas de negocio. | Evita contaminar estado y checkpoints. |
| `Monitor` detecta y alerta, pero no reasigna roles globales. | La autoridad estructural sigue en el `Agent`. |
| `Classifier`, `Planner` y `Router` no se separan sin necesidad real. | Evita diagramas redundantes. |

## Ownership De Niveles

Los niveles `N1` a `N5` son exclusivos. Cada nivel solo puede pertenecer a una entidad con capacidad de ejecución:

- `Agent`
- `Worker`
- `Backup`

Cuando un nivel está asignado, aparece con el color de la entidad propietaria y queda bloqueado para el resto. Esto evita que dos nodos reclamen el mismo nivel de complejidad.

Ejemplo:

```text
Agent(OpenAI) -> N4, N5
Worker(Gemini) -> N2, N3
Worker(Groq) -> N1
```

## Niveles De Arquitectura

### Nivel 0 - Básico

```text
Agent -> Worker
```

El `Agent` clasifica, planifica, enruta, valida ligeramente y agrega.

### Nivel 1 - Controlado

```text
Agent -> Worker
Agent -> Validator
Worker - - Guardian
```

Se añade apoyo o validación sin separar `Classifier`, `Planner` ni `Router`.

### Nivel 2 - Resiliente

```text
Backup
  :
Agent -> Memory -> Worker
Agent -> Monitor
```

Se usa cuando hay tareas largas, checkpoints, riesgo de timeout, límites de tokens o recuperación.

### Nivel 3 - Distribuido

```text
Agent -> Classifier -> Planner -> Router -> Workers
```

Solo para alta complejidad, muchas rutas, ejecución paralela, reglas finas o trazabilidad fuerte.

## Auditoría Esperada

Cada cambio estructural relevante debería dejar rastro:

- rol anterior y rol nuevo
- entidad que decide el cambio
- motivo
- tarea afectada, si aplica
- niveles afectados
- relación anterior y relación nueva
- capacidad usada, especialmente `Reallocator`
- timestamp

En el MVP, el layout se persiste en `data/routing_layout.json`. La siguiente fase debería registrar eventos de reasignación como decisiones auditables en SQLite.
