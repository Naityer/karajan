# CLI de Karajan

## `kj`: Karajan en producción desde la terminal

Karajan corre en producción como paquete de Atlas dev. `kj` es su terminal; el dashboard web anterior queda congelado.
Las consultas y simulaciones con implementación local se ejecutan directamente con rutas de datos explícitas. Para seleccionar
el paquete de Atlas dev usa `--http`: la dirección es `{ATLAS_DEV_API}/paquetes/karajan/api`, o `KARAJAN_API`, y se utiliza
el token de `at` (`ATLAS_DEV_TOKEN`). Se construye con `node atlas/build.mjs` y se ejecuta con `node dist-atlas/kj.mjs`.
El mapa de transportes y rutas está en [arquitectura-transportes.md](arquitectura-transportes.md) y los ejemplos locales del
dosificador en [uso-local-dosificador.md](uso-local-dosificador.md). Las operaciones todavía sin adaptador local usan Atlas.

| Comando | Qué hace |
|---|---|
| `kj componentes` | La pila de componentes por capas, con la responsabilidad de cada uno y el estado de su último laboratorio |
| `kj lab ls` | Laboratorios y escenarios (o qué borrador trae el que falta) |
| `kj lab run <componente\|todos> [--escenario x] [--sin-borradores]` | Ejecuta el laboratorio; los hallazgos `alta\|media` salen como borradores en Atlas dev |
| `kj lab informe <componente>` | Última ejecución de cada escenario: muestra, métricas y hallazgos |
| `kj lab historial <componente> <métrica>` | Evolución de una métrica (sparkline) |
| `kj grafica acierto\|eficiencia\|flujo\|matriz-skills\|sugerencias [--dias N] [--perfil activo\|todos]` | Gráficas de texto de la analítica de producción |
| `kj curador [--proponer]` | Skills que sobran, agrupadas por regla y con su evidencia; con `--proponer` cada una se abre como borrador en Atlas dev (idempotente). Solo propone: no retira nada |
| `kj grafica acierto\|eficiencia\|flujo\|matriz-skills --svg <fichero> [--html <fichero>]` | Exporta la misma gráfica como SVG autocontenido (barras horizontales, sin dependencias) y/o HTML autocontenido (título, el SVG y una tabla accesible con los datos). Colores por variables CSS y modo oscuro (`prefers-color-scheme`). `sugerencias` no se exporta |
| `kj comparar [<skill>\|karajan] [--grupo g]` | Cada skill del equipo (o Karajan) frente a las mejores de su grupo de la taxonomía, solo con estrellas propias: puesto, percentil, mejores pares y funcionalidades declaradas por ellos que le faltan; con `karajan`, además las pruebas con feedback humano que declaran los pares. «Sin dato» si no hay estrellas propias o el grupo tiene menos de 5 recursos con ellas |
| `kj dosificador estado` | Cuota de cada agente (uso semanal y de 5 h, techo, presupuesto libre, línea ideal), modo (normal, frenado, bloqueado), burn rate, agotamiento proyectado, circuitos abiertos y tareas en vuelo |
| `kj dosificador config [--set '<json>']` | La configuración del dosificador (`<datos>/dosificador.json`); con `--set` mezcla y guarda los campos (en producción necesita tarea aceptada) |
| `kj dosificador decidir --entrada <fichero.json>` | Decide con la entrada de `POST /dosificador/decidir` **sin guardar el estado** (simulacro): qué se lanza, dónde y cuándo, y qué se difiere y por qué |
| `kj dosificador simular [--semanas N] [--semilla S] [--demanda X]` | Simula semanas sintéticas con la configuración viva: semanas por encima del margen (objetivo 0), cuota sin usar al renovar (< 15 %), espera p95 y oscilaciones de modo |
| `kj analisis estado|procesar [--limite N] [--forzar] [--solo-registro]|reintentar|tarea <id>|taxonomia|exportar|destilar|config [--set '<json>']` | Histórico de tareas etiquetado con taxonomía normalizada: estado por versión y por error, pasada de procesamiento idempotente (modelos locales primero, Gemini de respaldo), análisis de una tarea, taxonomía, muestras para dpw7 y propuesta de destilación (ver [analisis-tareas.md](analisis-tareas.md)) |
| `kj tutoria [tutores\|actualizar\|brechas]` | Nota porcentual del agente local y qué niveles/dominios se le pueden delegar; `tutores` muestra el tutor vigente (razonamiento/precio) y `actualizar` lo recalcula con las fuentes en vivo; `brechas [--salida f.json]` da dónde falla el alumno (agregados anónimos) para la skill `skillforge-lab`, y la vista normal añade el efecto de sus skills forjadas |
| `kj propuestas` | Borradores que ha abierto Karajan y en qué estado están |
| `kj modo` | Producción o desarrollo (`<datos>/modo.json`; solo cambia editando el fichero) |

`kj lab ls` muestra el catálogo sin base; con `--lab-db <archivo>` o una ruta de datos Atlas configurada incluye las últimas ejecuciones. Una base indicada que no exista produce un error. Los paneles que necesitan Atlas o recursos comunican sus fallos de consulta en lugar de presentar listas vacías.

Todos admiten `--json`. En producción nada cambia la configuración sin una tarea aceptada: el agente que la ejecute repite la
petición con la cabecera `x-karajan-tarea: <id>`. Arquitectura y laboratorios: [laboratorio/componentes.md](laboratorio/componentes.md).

## SDK de componentes y módulos (salida ASCII)

Cada comando devuelve un **panel** (datos + bloques de presentación): en la terminal se pinta en ASCII (barras, medidores, tablas,
mapas de calor `░▒▓█`, árboles, rangos de percentiles, dispersión, flujo por capas) y con `--json` se entrega tal cual para que la
interfaz web lo dibuje con los mismos datos. Código en `atlas/src/sdk/` (`ascii.ts`, `panel.ts`, `comandos.ts`, `registro.ts`).

| Comando | Qué muestra |
|---|---|
| `kj <componente> describe` | Ficha: qué hace, entradas, pasos, salidas, reglas y su laboratorio |
| `kj planificador describe\|config\|salud\|metricas` | El planificador como cualquier componente (modos, plan y checker por la API `/planificador/*`, ver [componentes.md §10](laboratorio/componentes.md)) |
| `kj <componente> config [--set '<json>'] [--tarea <id>]` | Configuración viva; con `--set` la escribe por PUT en la ruta de escritura que el componente declara (hoy solo el dosificador; en producción necesita `--tarea` o `KARAJAN_TAREA`, la tarea aceptada de Atlas dev) |
| `kj componentes dependencias` | Mapa de dependencias entre componentes (de los imports reales), quién usa a quién, los independientes y las raíces de composición |
| `kj <componente> salud` | Estado de su laboratorio, último resultado por escenario y hallazgos con su borrador |
| `kj <componente> metricas` | Operación real (tareas, ejecuciones, latencia, coste, lo propio) e historial de métricas |
| `kj estadisticas resumen [--dias N] [--perfil activo\|todos]` | Indicadores, acierto, flujo entrada→nivel→agente→estado, coste frente a latencia y qué mejorar |
| `kj estadisticas agentes [--dias N] [--perfil …]` | Tareas, acierto, latencia p50/p90 y ranking por agente |
| `kj estadisticas skills [--dias N] [--perfil …]` | Actividad semanal, skills y categorías más usadas, mapas agente×skill y skill×categoría |
| `kj estadisticas tareas [--limite N]` · `kj estadisticas tarea <id>` | Lista de tareas; detalle con criterios de clasificación y decisiones |
| `kj inspiration resumen` | Recursos activos por tipo, estado, validez, origen y grupo |
| `kj inspiration lista [--tipo skill\|capability\|reference] [--estado e] [--runtime r] [--origen o] [--validez v] [--buscar texto] [--limite N]` | Catálogo con filtros (`★*` = estrellas heredadas del repo que recoge la skill) |
| `kj inspiration arbol [--grupo <id\|nombre>]` | Grupo → artefacto → componentes (hasta 12 por artefacto); `--grupo` acepta cualquier nivel |
| `kj inspiration grupos` · `ver <id\|slug>` · `radar` · `refresco` | Taxonomía con recuentos; ficha de un recurso; fuentes de descubrimiento; estado del último refresco |
| `kj inspiration revision` · `validez` | Recursos pendientes de aceptar y política de validez. **Limitación:** casi ningún recurso tiene estado de validez guardado en `resources.db` (lo evalúa el Karajan nativo al leerlo), así que aquí salen «sin dato» y lo avisan |

| `kj control estado` | Modo, proveedores listos, dosificador, borradores abiertos y revisiones pendientes de un vistazo |
| `kj control mapa` | Agentes por zona con su carga, errores y cuota usada, más la actividad reciente (sustituye al canvas de «Control humano») |
| `kj control jerarquia [--perfil <id>]` | Árbol de quién delega en quién (con vigilancias) y las reglas de enrutado |
| `kj control perfiles` · `kj control proveedores` · `kj control cuota` | Perfiles (el que ejecuta y el que se edita), proveedores disponibles y cuota por agente |
| `kj control revisiones` | Tareas que esperan revisión humana (la aprobación se hace desde Atlas dev) |
| `kj control mision "<texto>" [--ejecutar]` | Clasifica y planifica una tarea sin ejecutarla; con `--ejecutar` la delega de verdad y aplica los controles de revisión humana de la delegación |

`<componente>` es cualquiera de los de `kj componentes`. Los comandos propios de un componente (p. ej. `kj dosificador config`, que
también escribe) mandan sobre los genéricos. Inspiration es de solo lectura (`resources.db`, `ATLAS_KARAJAN_RESOURCES`): altas, instalación, revisión y recomendador siguen en el Karajan nativo. Pendiente: configuración escribible por componente.

## Servidor MCP y API nativa

La CLI Python `karajan` se ha retirado. Para operar el paquete de Atlas dev se usa `kj`, descrito arriba. Sus comandos hablan con la API de Atlas dev y no sustituyen necesariamente cada operación que ofrecía la CLI anterior.

El servidor MCP requiere el extra `pip install -e ".[mcp]"` y se inicia con `python -m karajan_cli.mcp_server`; expone, entre otras herramientas, `karajan_health`, `karajan_classify` y `karajan_assign`. Usa transporte embebido por defecto. Para HTTP, configura `KARAJAN_URL` o `KARAJAN_TRANSPORT=http` y arranca el servidor nativo con `python -m uvicorn app.main:app --host 127.0.0.1 --port 8001`.

La skill local se instala copiando `skills/karajan/` al directorio de skills del agente o mediante el instalador del catálogo. Reinicia la sesión del agente para cargarla.
