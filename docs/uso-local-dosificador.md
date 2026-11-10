# Simulación local del dosificador

La simulación puede ejecutarse sin servidor ni conexión de red indicando explícitamente el archivo de configuración del paquete de Atlas:

```powershell
node dist-atlas/kj.mjs dosificador simular --config <ruta-a-dosificador.json> --semanas 4 --json
```

El archivo debe existir y contener un objeto JSON; también puede indicarse con `KARAJAN_DOSIFICADOR_CONFIG`. El comando no crea configuración ni modifica el estado del dosificador. La simulación utiliza la misma normalización y operación que el endpoint HTTP. Usa `--http` para consultar el paquete de Atlas. `kj lab ls` también funciona localmente. `kj componentes` necesita `--datos <directorio>` y `--lab-db <laboratorio.db>` (o `KARAJAN_DATA_DIR` y `KARAJAN_LAB_DB`); abre el historial en solo lectura. `kj lab informe` e `historial` usan `--lab-db` o `KARAJAN_LAB_DB`. Los demás comandos no adquieren por ello un modo local.

Para decidir sin guardar el estado: `kj dosificador decidir --entrada entrada.json --config dosificador.json --estado dosificador-estado.json`. Las rutas de configuración y estado también pueden indicarse con `KARAJAN_DOSIFICADOR_CONFIG` y `KARAJAN_DOSIFICADOR_ESTADO`. Ambas deben existir: no se sustituye silenciosamente el estado por uno vacío. `--http` conserva el simulacro a través del servidor.

`kj dosificador config --config dosificador.json` lee la configuración local normalizada. Cambiarla con `--set` usa la API de Atlas y su guardián de producción; `--local --set` se rechaza. `kj modo --datos <directorio>` lee el modo local y falla si no puede leerlo.

El laboratorio sintético se ejecuta con `kj lab run dosificador --sin-borradores --config dosificador.json --lab-db laboratorio.db`. La base debe existir y tener el esquema actual; se guarda el informe en ella. La creación de borradores y los demás laboratorios usan Atlas mediante `--http`. La lista local `kj lab ls --json` muestra el catálogo sin historial: para obtener las últimas ejecuciones se utiliza `kj lab informe`.

Para construir la CLI después de modificar el código fuente se utiliza `node atlas/build.mjs`.
