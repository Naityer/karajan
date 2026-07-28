
# Documentador end-to-end

Documentador es un workspace especial de Atlas que contiene una única base de datos Commander identificada por `databases.workflow_key = documentador`. La página contenedora solo conserva las marcas internas de workspace protegido; el Header Protocol pertenece a cada tarjeta.

Una tarjeta nace en `Borrador` con Repository, Modo de ejecución, Comandos, Modelo y Skills. El modo está fijado a `documentar`. Repository puede detectarse en el prompt, pero debe resolverse a `atlas`, `karajan` o `naityer_setup` antes del envío. Las evoluciones conservan repositorio, modelo y skills y registran el eslabón padre.

## Flujo

1. Atlas clasifica el prompt en Karajan y vincula el `task_id` a la página.
2. El backend de Documentador delega con la raíz autorizada del repositorio y `agent_tools: doc`.
3. El agente local explora en solo lectura y termina con `propose_context`; `context_paths` viaja como dato estructurado.
4. Karajan vuelve a comprobar contención, tamaño y secretos y genera un paquete Markdown.
5. Atlas permite copiarlo, descargarlo y abrir ChatGPT Web. La respuesta vuelve pegada por el usuario; no se extrae automáticamente contenido del servicio web.
6. El resultado se registra en Karajan, se previsualiza en Atlas y queda `Listo para revisión`.
7. `Aceptar y publicar` escribe el documento fuente, actualiza el espejo `docs/apps/<app>/<slug>.md`, lo importa en Atlas dev y marca la tarjeta `Publicado`.

Los trabajos se guardan en `documentator_jobs`, una fila por página, con tarea, paquete, repositorio, rutas seleccionadas, hash del resultado, destinos, errores y fechas. Los reintentos reutilizan la misma fila y la importación de Atlas dev es idempotente por aplicación y slug.

## Seguridad y recuperación

- El cliente nunca decide una ruta local: envía un identificador de repositorio de una lista cerrada.
- Karajan revalida las rutas propuestas por el modelo y rechaza secretos o ficheros fuera de la raíz.
- La publicación usa slugs simples y comprueba que el destino permanezca dentro del repositorio.
- Un fallo parcial conserva el Markdown, deja la tarjeta en `Error` y permite reintentar.
- `Demo` ya no se genera. La migración funcional solo envía a la papelera el Demo anterior si mantiene la marca automática y su documento está vacío.

