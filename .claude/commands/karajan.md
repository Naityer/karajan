---
description: Clasifica y enruta la tarea con el harness KARAJAN (router padre + auditoría)
---

Usa la skill `karajan` para actuar como router padre: clasifica la siguiente
tarea por ámbito, complejidad y riesgo, **registra la decisión en el harness
local** (`POST /ingest`) y luego delega/ejecuta según la estrategia y el modelo
recomendados. No resuelvas la tarea directamente sin clasificar y registrar primero.

Si tienes el CLI `karajan` instalado, ejecuta primero `karajan activate` (o
`karajan activate --start` si aún no arrancaste el servidor) para garantizar
que el harness esté disponible antes de clasificar/registrar.

Tarea:

$ARGUMENTS
