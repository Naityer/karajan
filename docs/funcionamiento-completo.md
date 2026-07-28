# Karajan: funcionamiento, etiquetas, lógica y herramientas

Karajan es el router y harness local que convierte un prompt en una tarea trazable. Clasifica, elige proveedor/modelo, aplica puertas de coste o revisión, ejecuta y conserva decisiones, runs, eventos y artefactos. No es un modelo: coordina proveedores CLI o API disponibles.

## Clasificación y etiquetas

`POST /classify-task` crea una tarea a partir del prompt. `POST /ingest` acepta una clasificación propuesta por un agente padre y recalcula de forma determinista puntuación, nivel y tier. Los seis criterios son ambigüedad, contexto requerido, profundidad de razonamiento, autonomía, riesgo operativo y dificultad de validación.

Las etiquetas operativas principales son:

- `domain`, `intent`, `recommended_strategy` y `recommended_skills`;
- niveles `level_1_simple` a `level_5_critical`;
- tiers `cheap_model`, `cheap_or_medium_model`, `medium_model`, `strong_model` y `strong_model_with_human_review`;
- estados de tarea `classified`, `delegated`, `queued`, `completed` y `failed`.

El catálogo vivo resuelve cada tier a una entidad disponible. Una entidad describe proveedor, modelo, backend, autenticación, capacidades y salud. Si el proveedor primario falla, la cadena de fallback registra decisiones `fallback` y `reassign`; si ninguno está disponible, Karajan falla explícitamente y no simula una ejecución.

## Lógica de ejecución

`POST /delegate-task` ejecuta la clasificación. La puerta previa comprueba presupuesto y revisión humana. En modo síncrono responde al terminar; en modo cola deja el trabajo para el scheduler. `POST /tasks/{id}/approve-review` libera una tarea retenida.

Cada subtarea produce `SubtaskExecution`: backend, modelo usado, latencia, coste estimado, tokens, salida, error, iteraciones de validación y, para el perfil documental, `context_paths`. Los runs y sus eventos permiten auditar llamadas de herramientas y atribución real al proveedor.

## Agente local y perfiles de herramientas

El loop local solo se activa con una raíz de workspace explícita y un perfil conocido. La raíz se resuelve y todas las operaciones vuelven a comprobar contención. Los perfiles conceden subconjuntos del catálogo:

- lectura/exploración: listar, leer, buscar y localizar ficheros;
- construcción: escritura y edición acotadas, además de comandos permitidos;
- documentación (`doc`): exploración en solo lectura y terminal `propose_context`;
- control: `note`, `ask_human` y `finish` según el perfil.

Las herramientas tienen esquema de parámetros, riesgo, forma de retorno y fallos conocidos. El dispatcher valida y normaliza argumentos; un error de herramienta se convierte en resultado fallido, no derriba la sesión. Los comandos se ejecutan sin shell y con una lista cerrada de binarios; metacaracteres, rutas externas, secretos, binarios y tamaños excesivos se rechazan.

## Handoff documental

El perfil `doc` explora el repositorio y termina con `propose_context`. Las rutas válidas se conservan en `AgentOutcome.context_paths` y en cada `SubtaskExecution`, evitando extraerlas de texto libre.

`POST /handoff/packs` recibe tarea, prompt, raíz y rutas. Karajan las resuelve de nuevo, omite ficheros inseguros y limita el total y el tamaño por fichero. El paquete queda como artefacto `context_pack` y se consulta con `GET /handoff/packs/{id}`. Una respuesta pegada desde un chat externo entra por `POST /handoff/packs/{id}/result`, queda como `doc_result` y cambia el paquete a `ready`.

Atlas usa este ciclo para ChatGPT Web asistido: abre el servicio y prepara el paquete, pero el usuario controla el envío y el retorno del resultado. La aceptación y publicación pertenecen a Atlas; Karajan conserva contexto, respuesta y trazabilidad.

## Interfaces funcionales

- Salud, catálogo de proveedores, skills y perfiles de herramientas.
- Clasificación, ingestión, delegación, aprobación humana y listado de tareas.
- Layout de routing, métricas, rendimiento de agentes, eventos y artefactos.
- Ejecución con reintentos, fallback, presupuestos y validación.
- Loop de herramientas local con trazas y límites.
- Creación, consulta y retorno de paquetes documentales.

Los tokens compartidos y capacidades se validan en el borde. Atlas accede a Karajan por su proxy de add-ons; el navegador no recibe el secreto local.

