# Inventario de interfaces y contratos

Estado de referencia de la extracción. Las rutas concretas y esquemas canónicos están en `app/modules/*/api.py` y `atlas/src/servidor.ts`; este mapa no afirma que ambos servidores sean equivalentes.

| Entrada | Operaciones | Datos / efectos | Control y pruebas |
|---|---|---|---|
| `kj componentes`, `modo`, `lab ls`, `lab informe`, `lab historial` | Inventario y consulta | Catálogo en código, `modo.json`, `laboratorio.db`; lectura local explícita o HTTP | Sin mutación; `atlas/tests/cli.test.ts`, `arquitectura.test.ts`. La lista local incluye historial al indicar la base de laboratorio; sin ella muestra el catálogo sin historial. |
| `kj lab run` | Ejecuta escenarios | Escribe historial; puede proponer borradores a Atlas | Local solo dosificador sintético sin borradores, con base y configuración explícitas; resto HTTP. `cli.test.ts`, laboratorios. |
| `kj dosificador simular`, `decidir`, `config` | Simulación, simulacro y consulta | Lee configuración y, para decidir, estado; no guarda en local | `--set` es HTTP y pasa por guardián de producción; `cli.test.ts`, `dosificador-api.test.ts`. |
| `kj grafica`, `estadisticas` | Analítica, tareas y exportación SVG/HTML | Lectura local con `--tasks-db` y, para perfil activo, `--layout`; HTTP opcional; exportación escribe la ruta solicitada | `cli.test.ts`, `sdk.test.ts`. |
| `kj control` y comandos de componente | Estado, perfiles, proveedores, misión, fichas, métricas y configuración | `control perfiles/jerarquia`, `proveedores` y la planificación de `mision` admiten ejecución local; `control mision --ejecutar` delega por HTTP; `config --set` modifica | Conserva guardas de servidor; `sdk.test.ts`, `modo.test.ts`. |
| `kj inspiration` | Biblioteca, revisión y fuentes | Lectura local de `--resources-db` o `KARAJAN_RESOURCES_DB`; HTTP opcional | `inspiration-api.test.ts`; las altas siguen en la API Python. |
| `kj comparar` | Compara skills y capacidades | Biblioteca local en solo lectura o HTTP; descubre las skills del equipo | `comparador.test.ts`, `inspiration-api.test.ts`. |
| `kj curador`, `tutoria`, `propuestas` | Análisis y propuestas | HTTP; algunas lecturas requieren recursos locales; propuestas dependen de Atlas | `comparador.test.ts`, `modo.test.ts`. |
| MCP `karajan_run`, `classify`, `health`, `providers`, `assign`, `config_*`, `layout_*`, `provider_activate`, `stats` | Clasifica, ejecuta y administra | Cliente Python embebido por defecto o HTTP explícito; puede ejecutar proveedores o modificar estado | Adaptador `karajan_cli/client.py`; guardas de aplicación/identidad según operación; pruebas `tests/architecture/` y `tests/api/`. |
| Python API `/v1` | Salud, clasificación, ejecución, consulta y cancelación | Contenedor Python y SQLite | Operaciones protegidas por la identidad configurada; `tests/architecture/test_embedded_architecture.py`. |
| Python API anterior | `/classify-task`, `/ingest`, `/delegate-task`, tareas, revisiones, recursos, configuración y observabilidad | SQLite, proveedores, cola y recursos | Las dependencias de cada ruta son la fuente de verdad; `tests/api/`, `tests/execution/`, `tests/resources/`. |
| Atlas dev | Rutas del paquete registradas por `registrar` | Almacén del paquete o base nativa compartida; servicios de Atlas para tareas y borradores | Guardián de producción en mutaciones previstas; `atlas/tests/modo.test.ts`, pruebas de API. |

Los adaptadores no dan permisos adicionales: una operación local no debe evitar las verificaciones de una mutación. Los nuevos caminos locales son consultas, simulacros y un laboratorio sintético que solo guarda su informe. `--local` rechaza operaciones sin implementación local, y `--http` selecciona el servidor configurado. En errores de lectura no se crea una base nueva.

Las decisiones sobre consolidar Python y TypeScript, portar capacidades ausentes o retirar interfaces están pendientes de una comparación de comportamiento y sus consumidores. La documentación histórica de `atlas/PORTE.md` contiene etapas anteriores y no sustituye al código actual para resolver rutas de datos compartidas.

La [matriz de capacidades y contratos](matriz-capacidades-contratos.md) detalla las rutas registradas en Python y Atlas, las herramientas MCP, comandos del SDK, archivos de datos y pruebas relacionadas. Sus límites explícitos distinguen las declaraciones estáticas de la autorización y paridad realmente comprobadas.
