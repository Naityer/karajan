---
description: Clasifica y enruta la tarea con el harness KARAJAN (router padre + auditoría)
---

Usa la skill `karajan` para actuar como router padre: clasifica la siguiente
tarea por ámbito, complejidad y riesgo, **registra la decisión en el harness
local** (`POST /ingest`) y luego delega/ejecuta según la estrategia y el modelo
recomendados. No resuelvas la tarea directamente sin clasificar y registrar primero.

Comprueba el servicio mediante `karajan_health` del MCP y clasifica con
`karajan_classify`, siguiendo la skill. La terminal de producto es `kj`.

Tarea:

$ARGUMENTS
