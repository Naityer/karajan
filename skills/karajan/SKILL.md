---
name: karajan
description: Router/orquestador de tareas de KARAJAN. Para cualquier tarea de desarrollo no trivial (bugs, features, refactors, análisis, decisiones de arquitectura), actúa como el LLM padre en vez de resolverla directamente — clasifica por ámbito/complejidad/riesgo, registra la decisión en el harness local KARAJAN y delega según la estrategia y el modelo recomendados. Aplica tanto si el usuario invoca /karajan explícitamente como si plantea la tarea directamente, sin comando.
---

# KARAJAN — Router de tareas (harness)

Se activa tanto con el comando `/karajan` como automáticamente cuando el
usuario plantea una tarea de desarrollo no trivial directamente, sin comando
explícito. Cuando se activa, **no resuelvas la tarea directamente**: actúas
como el **LLM padre / router**. Clasificas, ponderas, registras la decisión
en el harness y delegas. El harness KARAJAN guarda cada decisión para
monitoreo y auditoría; tú eres quien recibe el prompt y decide.

No hace falta estar dentro del repo de KARAJAN para usar esta skill: todo el
registro se hace por HTTP (`karajan` CLI o `curl` contra `KARAJAN_API`), así
que funciona desde cualquier proyecto una vez que el harness está activo
(`karajan activate --start` una vez recuerda dónde está el repo para
próximas veces).

## Flujo

1. **Clasifica** el prompt del usuario. Puntúa de 0 a 5 cada criterio:
   `ambiguity`, `context_required`, `reasoning_depth`, `autonomy_required`,
   `operational_risk`, `validation_difficulty`.
2. **Detecta** `domain` (p.ej. security, devops, programming, data, documents,
   product) e `intent`, y divide en `subtasks` acotadas.
3. **Recomienda skills/estrategias** del agente (`recommended_skills`): p.ej.
   `repo-analyzer`, `security-review`, `backend-builder`, `frontend-builder`,
   `cti-analyst`, `promptfoo`, y siempre `ponytail` (mínimo código seguro).
4. **Registra la decisión** en el harness con un POST a `/ingest`. Guarda el
   `task_id` devuelto. El harness **recalcula** `complexity_score`,
   `complexity_level` y `recommended_model` de forma determinista — no los fijes tú.
5. **Ejecuta/delega** según `recommended_strategy` y el modelo recomendado,
   apoyándote en las skills sugeridas. Si `requires_human_review` es `true`,
   pide confirmación humana antes de acciones irreversibles.
6. **(Opcional) Reporta** cada decisión real de ejecución con un POST a
   `/tasks/{task_id}/decisions` para enriquecer la auditoría en vivo.

Si el CLI `karajan` está instalado (`pip install -e .` en la raíz del repo),
prefiérelo sobre el `curl` crudo de los pasos 4 y 6: `karajan ingest --file
payload.json` / `karajan tasks decisions <task_id>` manejan servidor caído,
reintentos y formato de salida. El `curl` de abajo queda como fallback si el
CLI no está disponible en el entorno del agente.

## Roles del diagrama

El padre del harness se modela como `Agent`. `Agent` ya incluye clasificación,
planificación, routing, agregación ligera y recuperación básica. No crees
`Classifier`, `Planner` o `Router` como nodos separados salvo que haya alta
complejidad, mucha carga, varias rutas o necesidad fuerte de trazabilidad.

Roles visibles:

- `Agent`: autoridad estructural; clasifica, decide, enruta y delega.
- `Worker`: ejecuta tareas concretas asignadas por el `Agent`.
- `Backup`: reserva en standby; solo asume autoridad si se promueve a `Agent`.
- `Guardian`: apoya o revisa un `Worker` concreto.
- `Validator`: valida salidas de otros nodos.
- `Memory`: conserva estado, checkpoints y contexto.
- `Monitor`: detecta salud, timeouts, errores y saturación.

Capacidad especial:

- `Reallocator` solo puede existir dentro de un `Agent`. Permite reasignar
  roles, tareas, prioridades y relaciones cuando la jerarquía se rompe o se
  vuelve ineficiente. `Worker`, `Guardian`, `Validator`, `Memory` y `Monitor`
  pueden informar problemas, pero no pueden reasignar roles globales.

## Registro en el harness

`KARAJAN_API` por defecto es `http://127.0.0.1:8000` (si sirves la app en otro
puerto, exporta `KARAJAN_API`, p.ej. `http://127.0.0.1:8001`). Antes de
registrar nada, `karajan activate` (o `karajan activate --start`) confirma que
el harness está arriba — evita fallos de conexión a mitad del flujo.

```bash
curl -s "${KARAJAN_API:-http://127.0.0.1:8000}/ingest" \
  -H 'Content-Type: application/json' \
  -d '{
    "original_prompt": "<prompt del usuario>",
    "domain": ["devops","programming"],
    "intent": "diagnose_and_fix",
    "criteria": {"ambiguity":1.5,"context_required":2,"reasoning_depth":2,
                 "autonomy_required":1.5,"operational_risk":1,"validation_difficulty":1.5},
    "recommended_strategy": "divide_and_delegate",
    "recommended_skills": ["repo-analyzer","ponytail"],
    "subtasks": [
      {"id":"sub_001","name":"Analizar causa","complexity":3,
       "recommended_model":"medium_model","recommended_skill":"repo-analyzer",
       "validation":"Reproducir el fallo"}
    ],
    "reason": "Afecta a CI/CD; requiere validar en pipeline."
  }'
```

Reportar una decisión de ejecución (opcional):

```bash
curl -s "${KARAJAN_API:-http://127.0.0.1:8000}/tasks/<task_id>/decisions" \
  -H 'Content-Type: application/json' \
  -d '{"task_id":"<task_id>","phase":"delegate","decision":"sub_001->claude-sonnet","reason":"ejecutado"}'
```

La regla de oro: el padre clasifica, pondera y coordina; los submodelos ejecutan
subtareas delimitadas; el padre valida la coherencia final.
