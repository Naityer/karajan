# Capacidades, datos y puntos de entrada

Este inventario describe el estado actual, no implica paridad entre motores. El motor Python vive en `app/`; el paquete TypeScript vive en `atlas/`. Los dos tienen sus propios contratos y pruebas. No se ha retirado ninguno.

| Capacidad | Python | TypeScript / Atlas | Entrada y dependencias |
|---|---|---|---|
| Clasificación, perfiles, delegación | `routing/`, `execution/` | `heuristica.ts`, `perfiles.ts`, `delegar.ts` | API Python, MCP o paquete Atlas; el proveedor elegido debe estar disponible. Las implementaciones no son idénticas. |
| Herramientas del agente | `agent_tools/` | Sin paridad completa | Ejecución Python; requiere workspace y perfil de herramientas. |
| Catálogo y laboratorios | No equivalente completo | `componentes.ts`, `laboratorio.ts` | `kj lab ls`, `informe` e `historial` locales; ejecución de laboratorios por Atlas salvo el dosificador sintético sin borradores. La lista incluye historial cuando se configura una base existente; informe e historial necesitan la base explícita. |
| Estado de componentes | No equivalente | `componentes.ts` | `kj componentes` local requiere modo y base de laboratorio explícitos; abre la base en solo lectura. `--http` consulta Atlas. |
| Dosificador | Sin paridad completa | `dosificador*.ts` | Simulación y decisión sin guardar en local con configuración y estado explícitos, o mediante HTTP; la modificación de configuración y estado permanece en Atlas. |
| Recursos e Inspiration | `resources/` | Biblioteca y comparador parciales | `kj inspiration` consulta `resources.db` en solo lectura por `--resources-db` / `KARAJAN_RESOURCES_DB` o HTTP; las operaciones difieren por motor. |
| Analítica | `analytics/` | `analitica.ts`, `produccion.ts` | Consulta datos de ejecuciones; algunas vistas de producción usan tareas de Atlas. |
| Handoff documental | `handoff/` | Sin paridad completa | API Python y datos de handoff; la publicación corresponde al consumidor. |

`app/main.py` monta FastAPI; `karajan_cli/mcp_server.py` ofrece MCP con cliente embebido o HTTP. `atlas/src/servidor.ts` registra rutas en Atlas dev; `atlas/src/cli.ts` es la terminal. Los endpoints de mutación existentes conservan sus controles de token y de tarea aceptada. El modo local lee, simula y puede guardar el informe del laboratorio sintético; no habilita cambios de configuración ni ejecución de agentes.

El servidor MCP necesita el extra opcional del proyecto: `python -m pip install -e ".[mcp]"`. Por defecto se ejecuta embebido con `python -m karajan_cli.mcp_server`; la selección HTTP es explícita mediante `KARAJAN_URL` o `KARAJAN_TRANSPORT=http`.

La construcción del entorno TypeScript está en `atlas/src/runtime.ts`: instancia repositorios, proveedores y guardián sin registrar rutas HTTP y ofrece cierre de las bases. El servidor de Atlas adapta ese entorno a sus rutas; una ruta `ATLAS_KARAJAN_DATA` explícita inexistente produce error en vez de crear otro almacén silenciosamente. El cliente embebido Python conserva su contenedor y su bloqueo de propietario propios; no se asume que ambos modelos de concurrencia sean equivalentes.

`atlas/src/aplicacion.ts` reúne operaciones reutilizables de clasificación, planificación, delegación, perfiles, rotación, catálogo y analítica; `aplicacion-dosificador.ts` y `aplicacion-laboratorio.ts` coordinan las capacidades correspondientes. Las mutaciones de perfiles, rotación y configuración del dosificador aplican el guardián también cuando se invocan directamente. Si no se puede guardar el estado del dosificador, la API responde con un error explícito; la simulación no escribe. El cliente Python embebido rechaza cambios de configuración y perfiles en producción porque aún no recibe un identificador de tarea aceptada; HTTP conserva su cabecera de tarea. Un `modo.json` ausente conserva la compatibilidad de desarrollo del motor Python, pero un fichero inválido o ilegible activa producción.

Las mutaciones embebidas de configuración y perfiles también requieren la capacidad `karajan:config:write` de la identidad autenticada. Esta comprobación no suple la propagación de identidad desde Atlas al paquete TypeScript, que sigue pendiente de la propuesta del ADR 0003.

En la instalación Python, `data/task_logs.db`, `data/resources.db`, `data/active_config.json`, `data/routing_layout.json` y `data/modo.json` son estado local; algunos están ignorados por Git. Atlas puede compartir la base y configuración nativas mediante `ATLAS_KARAJAN_DATA` o `ATLAS_WORKSPACE`; el laboratorio y el dosificador usan datos del paquete de Atlas. La terminal exige rutas explícitas para estas lecturas, no busca una base sustituta ni crea una nueva. SQLite puede estar en WAL: sus archivos asociados no deben separarse de una base activa.

Si `ATLAS_KARAJAN_COMPARTIR=0` y se importa una base nativa, el paquete obtiene una instantánea SQLite mediante `VACUUM INTO` y la publica después de completarla. La importación usa un directorio de bloqueo exclusivo y rechaza abrir el destino mientras esté presente. Si una interrupción o un fallo tras publicar la base deja `.task-import-lock`, hay que comprobar que no haya una importación activa y revisar la base y la configuración antes de retirar el bloqueo. La configuración JSON se copia por separado y no forma parte de una transacción con la base.

La UI de `atlas/ui/` se empaqueta para Atlas; `dashboard/` es la interfaz anterior congelada. `dist-atlas/`, `.venv/` y `atlas/node_modules/` son artefactos o dependencias generados. No se debe confundir presencia en disco con seguimiento por Git.

La clasificación y las operaciones HTTP siguen requiriendo las pruebas de sus respectivos motores. La terminal usa `--http` para solicitar de forma explícita las variantes HTTP disponibles; `--local` rechaza operaciones sin adaptador local. La extracción está en curso: no se debe asumir que `--local` cubre todos los comandos.

La prueba `atlas/tests/cli-paridad.test.ts` compara texto y JSON de operaciones locales con los manejadores HTTP reales del paquete sobre una copia temporal de la base de tareas. En particular, una entrada inválida de `dosificador decidir` conserva una diferencia histórica: en local se informa del error y se devuelve código 2; por HTTP el error de la API llega a la CLI como excepción y el programa termina con código 1. Ambos modos muestran el detalle del error.

`kj control perfiles --layout routing_layout.json` y `kj control jerarquia --layout routing_layout.json` consultan el archivo local mediante la misma validación y proyección que el servidor; también se puede indicar `KARAJAN_ROUTING_LAYOUT`. `kj control proveedores` usa la misma detección que Atlas: busca ejecutables y, para Ollama, ejecuta `ollama list`, que consulta la instancia configurada. La modificación de perfiles continúa protegida en Atlas. Los archivos ausentes o inválidos se comunican como error, sin sustituirlos por un perfil vacío.

`kj control mision "texto" --datos <directorio>` clasifica y planifica en local con `active_config.json`, `routing_layout.json` y `task_logs.db` existentes, sin ejecutar al agente ni guardar una tarea. `--ejecutar` usa el servicio HTTP; no se permite combinarlo con `--local`. La planificación sondea la disponibilidad de proveedores de la misma forma que el paquete.

`kj estadisticas` y `kj grafica` consultan tareas y analítica sin abrir la base para escritura mediante `--tasks-db task_logs.db` o `KARAJAN_TASKS_DB`. Se requiere una base existente y compatible. Con `--perfil activo` se exige además `--layout` o `KARAJAN_ROUTING_LAYOUT`; se comprueba la disponibilidad de los proveedores del perfil. `--http` conserva la consulta al paquete.

Para evitar indicar cada fichero, `--datos <directorio>` o `KARAJAN_DATA_DIR` permite localizar `task_logs.db`, `resources.db`, `routing_layout.json` y `modo.json`. `--datos-atlas <directorio>` o `KARAJAN_ATLAS_DATA_DIR` localiza la configuración del dosificador y `laboratorio/laboratorio.db` dentro de los datos del paquete. Una opción de fichero o variable específica tiene prioridad sobre su directorio. No se crea ningún archivo si no existe.
