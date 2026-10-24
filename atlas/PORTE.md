# Karajan dentro de Atlas dev: qué se ha portado a TypeScript y qué no

Este directorio es el **paquete de Atlas dev** de Karajan (`atlas-package.json` en la raíz del repo). Atlas dev lo instala como un
`.atlaspkg` y lo ejecuta **en su propio proceso Node**: sin servicio Python, sin puerto, sin `uvicorn`. Karajan conserva su
interfaz y su servidor nativos; esto es una segunda forma de usar su núcleo.

Es un puerto, no un envoltorio: el código de `app/` en Python **no se toca** y sigue siendo la referencia. La fidelidad se
comprueba contra él (ver «Paridad»).

## Hecho (v0.1)

| Pieza | Origen en Python | Aquí |
|---|---|---|
| Clasificador heurístico (dominios, intención, 6 criterios, nivel, modelo, skills, subtareas, revisión humana, razón) | `app/routing/router.py`, parte determinista de `app/routing/classifier.py` | `src/heuristica.ts` |
| Redondeo y formato como Python (`round`, `:.1f`, `sum()` compensado de 3.12) | — | `src/redondeo.ts`, `sumaPython` |
| Registro de tareas: lectura, runs, decisiones, `/metrics`, `/agents/performance` | `app/database.py` (`TaskStore`) | `src/almacen.ts` (`node:sqlite`) |
| Analítica de skills (recomendada ≠ ejecutada) | `app/resources/skill_analytics.py` | `src/analitica.ts` |
| Catálogo de skills con su estado de instalación | `app/resources/skills_catalog.py` (lectura) | `src/catalogo.ts` |
| Servidor | `app/modules/monitoring/api.py` y rutas de tareas | `src/servidor.ts` (`registrar(app, ctx)` de Fastify) |
| Perfiles de enrutado (lectura y escritura, compartidos) | `app/routing/routing_layout.py`, `RoutingLayout` de `app/models.py` | `src/perfiles.ts` |
| Reglas por dominio y preset «Claude · Codex · Qwen» | `app/routing/routing_rules.py` | `src/reglas.ts` |
| Proveedores CLI (Claude Code, Codex, Qwen/ollama) | `app/providers/catalog.py`, `app/providers/cli.py` | `src/proveedores.ts` |
| Delegación real (clasificar, elegir agente, ejecutar, registrar) | `app/execution/delegation.py` (camino síncrono, sin validador ni bucle de herramientas) | `src/delegar.ts` |

Rutas (las de la API de Karajan, para que lo que ya habla con ella funcione igual): `GET /health`, `/metrics`,
`/agents/performance`, `/analytics/skills?days=`, `/tasks`, `/tasks/:id`, `/tasks/:id/runs`, `/tasks/:id/decisions`,
`/search/tasks?q=`, `/skills`, `/config` y `POST /classify-task` (heurístico, **no persiste**). Desde v0.2: `GET/PUT /routing-layout`,
`POST /routing-layout/presets/dominios`, `GET /providers`, `POST /routing/plan` (a quién iría cada subtarea, sin ejecutar) y
`POST /delegate-task` (**ejecuta de verdad**; ver `docs/perfiles-y-reglas.md`).

Atlas dev reenvía `/paquetes/karajan/api/*` a este servidor y su puente `/karajan/*` (widgets «Estadísticas» e «Inspection» del
Home) se resuelve contra él cuando el paquete está instalado.

## v0.7: componentes, laboratorio, modo producción y `kj`

Ver `docs/laboratorio/componentes.md`. Es nuevo del paquete, no un puerto: en Python solo existe el modo (`app/modo.py`), que
lee el mismo `modo.json`.

| Pieza | Aquí |
|---|---|
| Registro de componentes (capa, responsabilidad única, módulos, laboratorio) | `src/componentes.ts` |
| Motor del laboratorio (tareas de Atlas dev anonimizadas, Wilson, `laboratorio.db`) | `src/laboratorio.ts` |
| Laboratorios del delegador, selector, clasificador y biblioteca | `src/lab/*.lab.ts` |
| Modo producción: mutaciones con tarea aceptada o 423 + borrador | `src/modo.ts`, `src/atlas-dev.ts` |
| Pasarela de borradores (hallazgo → tarea borrador idempotente en Atlas dev) | `src/pasarela-borradores.ts` |
| Biblioteca de recursos en solo lectura (ficha, estrellas propias/heredadas, búsqueda) | `src/biblioteca.ts` |
| `kj`, la terminal (`dist-atlas/kj.mjs`) | `src/cli.ts` |

Rutas nuevas: `GET /laboratorio/componentes`, `/laboratorio/ejecuciones`, `/laboratorio/modo`, `/laboratorio/propuestas`,
`/laboratorio/sugerencias-skills?prompt=&q=`; `POST /laboratorio/ejecutar` y `/laboratorio/calibracion`. En producción,
`PUT /routing-layout`, los presets, `desde-texto` con `aplicar` y `skills/rotar` con `aplicar` necesitan la cabecera
`x-karajan-tarea` con una tarea encolada o en marcha. `PESOS_SELECTOR` (`skills-seleccion.ts`) deja los pesos del ponderador a la
vista para que el laboratorio los calibre, con el mismo comportamiento por defecto.

## Datos

`<datos del paquete>/task_logs.db` y `active_config.json`. Si no existen y `ATLAS_KARAJAN_DATA` apunta a la carpeta `data/` de un
Karajan, se **copian** al arrancar (no se comparte fichero con el Karajan nativo). El esquema es el de Karajan, de modo que la
copia es compatible en los dos sentidos.

Los **perfiles** sí se comparten con el Karajan nativo: `ATLAS_KARAJAN_LAYOUT`, o `<ATLAS_KARAJAN_DATA>/routing_layout.json`, o
`<datos>/routing_layout.json` si no hay Karajan. Las tareas que delega el paquete se registran en su copia de `task_logs.db`
(tablas `tasks`, `decisions` y `runs`; no en `tasks_v2` ni en FTS), así que el Karajan nativo no las ve.

## Todavía no (responden 501)

- **`/executions` e `/ingest`**, y en `/delegate-task` lo que va más allá del camino síncrono: el bucle de herramientas con shell,
  los reintentos, el validador, el modo cola (scheduler) y la doble escritura `tasks`/`tasks_v2`. Proveedores: solo los tres CLI
  del perfil por dominio (Claude Code, Codex y Qwen con ollama); ni APIs ni el resto de modelos locales.
- **Clasificación con LLM** (`app/routing/classifier.py::_llm_classify`) y `reconcile` de `/ingest`.
- **Biblioteca de recursos «Inspiration»** y el **recomendador** (`resource_library`, `resource_intelligence`, ~1900 líneas más
  `resources.db` de 18 MB con heurísticas y datos propios): `/resources/*`. El widget Inspection lo muestra como error del servicio.
- **Scheduler, refresco de recursos, SSE (`/events`), observabilidad con historial, analítica DuckDB/ML** y la **instalación** de
  skills (`install_skill`, necesita git y copiar ficheros).
- **Búsqueda FTS5**: aquí `LIKE` sobre el prompt (el original ya recurre a `LIKE` cuando FTS5 no está).
- La interfaz completa de Karajan (DOM imperativo y 13 k líneas de CSS global): no se porta; se queda en su repo.

Orden recomendado para lo que falta: (1) clasificación con LLM (la heurística puntúa bajo los prompts cortos); (2) validador y
reintentos en la delegación; (3) biblioteca de recursos; (4) el resto.

## Paridad con Python

`tests/fixtures/` lo genera el propio Python (no a mano):

- `clasificacion.json`: `classify_prompt` con y sin `KarajanConfig` sobre 30 prompts (español/inglés, vacíos de señal, muy largos,
  con tildes, empates exactos de redondeo).
- `tareas.db` + `analitica.json`: una base sintética creada con `TaskStore` (16 tareas, delegaciones y 22 runs) y las salidas de
  `metrics()`, `agent_performance()` y `build_skill_analytics()` a 0, 30 y 3650 días con un «ahora» fijo.

`npm test --prefix atlas` exige igualdad valor a valor (70 tests). Para regenerarlas, con el venv de Karajan desde la raíz del repo:
`.venv/Scripts/python.exe atlas/tests/generar_fixtures.py atlas/tests/fixtures`. Además
se contrastó una vez contra los datos reales de `data/task_logs.db` (copia): métricas, rendimiento por agente y analítica a 0 y
3650 días idénticas.

Dos detalles de fidelidad que costaron un fallo real:
- Python ≥ 3.12 suma floats con **suma compensada** (Neumaier): `0.2 + 0.88 + …` da 2.33 y no 2.34. Sin `sumaPython` la
  puntuación de complejidad difería en un centésimo en algunos prompts.
- `round()` y `format(x, '.1f')` de Python redondean los empates exactos **al par** (3.25 → 3.2); `toFixed`/`Math.round` los
  redondean hacia arriba.
- Las tareas antiguas con `backend` desconocido (p. ej. `simulated`) las descarta Python al validar con Pydantic; aquí también en
  listados y analítica (pero `/metrics`, que agrega en SQL, las cuenta, igual que en Python).

## Construir y empaquetar

```
npm install --prefix atlas      # solo esbuild (desarrollo)
npm test --prefix atlas         # paridad
# en el repo de Atlas dev (server/): 
npm run paquete -- <ruta-de-karajan>
```
