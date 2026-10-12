# Perfiles de enrutado y reglas por dominio

Un **perfil** es un lienzo de la vista Decisión: qué agentes hay (entidades), qué niveles de complejidad cubre cada uno, su
concurrencia, sus skills y, desde ahora, **reglas por dominio** que deciden a qué agente va cada subtarea según el tipo de trabajo.
Se guardan todos en `data/routing_layout.json` (o en Postgres en modo SaaS).

## Activo y por defecto

- **Activo** (`active_profile_id`): el que estás editando en el lienzo.
- **Por defecto** (`default_profile_id`): el que **se ejecuta**. `delegate` y el scheduler proyectan siempre el perfil por
  defecto (`RoutingLayout.project_default_profile()`), no el activo. Para que un perfil nuevo mande, márcalo por defecto.

## Esquema

```jsonc
{
  "active_profile_id": "por-dominio",
  "default_profile_id": "por-dominio",
  "profiles": [{
    "id": "por-dominio",                       // ^[A-Za-z0-9][A-Za-z0-9._-]*$
    "name": "Claude · Codex · Qwen (por dominio)",
    "entities": [{ "id": "dominio-codex", "role": "worker", "provider": "codex", "levels": ["level_1_simple", "…"],
                   "max_concurrent": 2, "skills": [], "x": 480, "y": 430 }],
    "groups": [],
    "rules": [                                  // opcional; los ficheros antiguos siguen siendo válidos
      { "id": "backend-oficina", "name": "Backend, oficina e informes → Codex", "entity_id": "dominio-codex",
        "domains": ["backend", "oficina", "data", "devops", "documents"], "intents": [], "level_min": null, "level_max": null,
        "enabled": true }
    ]
  }]
}
```

Una regla casa cuando **todos** sus filtros casan; una lista vacía o un límite `null` significan «cualquiera»:

| Campo | Casa si… |
|---|---|
| `domains` | alguno coincide con los dominios del clasificador (`programming`, `data`, `documents`, `devops`, `security`, `product`, `general`) **o** con las áreas detectadas en el prompt (`frontend`, `backend`, `oficina`, ver `app/routing_rules.py::AREA_KEYWORDS`) |
| `intents` | la intención es una de ellas (`implement_feature`, `diagnose_and_fix`, `analyze_or_review`, `transform_or_extract`, `classify_and_plan`) |
| `level_min` / `level_max` | el nivel (1–5) está en el rango. El nivel que ve una regla es el **de la tarea**, o el de la subtarea si es mayor (`rule_level`) |
| `enabled` | no está desactivada |

Se evalúan **en orden** y gana la primera que casa. Una regla cuyo agente ya no existe se ignora (no invalida el fichero). Si
ninguna casa, el enrutado es el de siempre: `provider_preferences` por nivel (despacho síncrono) o niveles, Prio y concurrencia
del lienzo (modo cola). Forzar un agente (`force_provider` / `force_entity_id`) pasa por encima de las reglas.

Cada subtarea enrutada por una regla deja una decisión `assign` con `rule:<regla>-><entidad>:<proveedor>` en el registro.

## El preset por dominio

`POST /routing-layout/presets/dominios` (paquete de Atlas dev) o el botón del panel de perfiles crea «Claude · Codex · Qwen
(por dominio)» y lo deja activo y por defecto:

1. **Interfaces y diseño** (`frontend`) de nivel 2 o más → **Claude Code** (`claude-cli`; haiku/sonnet/opus según el nivel).
2. **Backend, oficina e informes** (`backend`, `oficina`, `data`, `devops`, `documents`) → **Codex**.
3. **Tareas sencillas** (nivel ≤ 2) → **Qwen local** (`ollama-qwen`, `qwen2.5:7b`).
4. Todo lo demás → **Codex**.

El orden importa: el backend va a Codex aunque sea sencillo, y un retoque trivial de interfaz (nivel 1) va a Qwen. Todo se puede
editar: añadir reglas, reordenarlas, cambiar dominios o niveles. Si el agente elegido no está disponible en el equipo (CLI fuera
del PATH, ollama parado o sin el modelo), el paquete usa el primero disponible de Codex → Claude → Qwen y lo anota en el motivo.

## Skills de cada agente

`entity.skills` se guarda con el perfil y se muestra en el panel, pero **no interviene en el enrutado**: elegir agente es cosa de
los niveles y de las reglas. Las skills que se recomiendan a cada tarea salen del clasificador (`recommended_skills`) y de la
Biblioteca; la analítica de recomendadas frente a ejecutadas está en `GET /analytics/skills`.

## Desde Atlas dev (sin Karajan Python levantado)

El paquete `karajan` de Atlas dev lee y escribe **el mismo** `routing_layout.json` (`ATLAS_KARAJAN_LAYOUT`, o
`<ATLAS_KARAJAN_DATA>/routing_layout.json`), con copia `.bak`, y conserva las reglas cuando el lienzo nativo guarda sin ellas.
Además ejecuta de verdad: `POST /delegate-task {prompt, force_entity_id?, cwd?, human_approved?}` clasifica (heurística), elige el
agente con las reglas del perfil por defecto y lanza su CLI como subproceso (sin shell, instrucción por stdin), y responde `202`
con el plan; el resultado se lee en `/tasks/:id`, `/tasks/:id/runs` y `/tasks/:id/decisions`. `POST /routing/plan` devuelve el
plan sin ejecutar nada. Las tareas que exigen revisión humana no se ejecutan: la respuesta trae `bloqueada` con el motivo hasta que se reenvían con `human_approved: true`.

Para que la skill `karajan` de Claude Code o Codex hable con el paquete en vez de con el servidor Python:

```bash
KARAJAN_URL=http://127.0.0.1:4100/paquetes/karajan/api
```

Limitaciones del paquete frente al Python: sin clasificación con LLM (la heurística puntúa bajo los prompts cortos), sin validador
ni reintentos, sin modo cola y con solo los tres CLI del preset. Ver `atlas/PORTE.md`.
