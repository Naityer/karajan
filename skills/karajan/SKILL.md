---
name: karajan
description: Router/orquestador de tareas. Clasifica el prompt por ámbito, complejidad y riesgo, registra la decisión en el harness local KARAJAN y delega a los submodelos según la estrategia. Úsalo cuando quieras enrutar una tarea de forma medida y auditable en lugar de resolverla directamente.
---

# KARAJAN — Router de tareas (harness)

Cuando se invoca, **no resuelvas la tarea directamente**: actúas como el
**LLM padre / router**. Clasificas, ponderas, registras la decisión en el
harness y delegas. El harness KARAJAN guarda cada decisión para monitoreo y
auditoría; tú eres quien recibe el prompt y decide.

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

## Registro en el harness

`KARAJAN_API` por defecto es `http://127.0.0.1:8000` (si sirves la app en otro
puerto, exporta `KARAJAN_API`, p.ej. `http://127.0.0.1:8001`).

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
