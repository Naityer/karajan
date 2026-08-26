---
name: karajan
description: Clasifica y registra tareas de desarrollo en el router local KARAJAN; delega a otro agente solo cuando el usuario pide ejecución real. Úsala para routing, selección de agente, trazabilidad o coordinación local.
---

# KARAJAN — router local de tareas

Usa KARAJAN como una skill local y portable. La clasificación, la decisión y el historial permanecen en el harness local.
No reproduzcas manualmente su clasificador ni construyas payloads `/ingest` salvo que el usuario aporte una clasificación ya hecha.

## Flujo normal

1. Comprueba el servicio con `karajan activate`. Si no responde, ejecuta una sola vez `karajan activate --start`.
2. Para clasificar y registrar una tarea sin ejecutarla externamente: `karajan --json classify "<tarea>"`.
3. Lee el nivel, estrategia, skills y agente recomendados y continúa localmente cuando el entorno actual sea el ejecutor adecuado.

No llames por separado a `/health`, `/ingest`, `/tasks` y `/decisions` para una operación que ya cubre el CLI.

## Delegación opcional

Solo cuando el usuario pida ejecutar mediante otro agente o proveedor, usa una invocación única:
`karajan --json assign --prompt "<tarea>" --to <proveedor>`

La delegación puede enviar el prompt y el contexto suministrado al proveedor elegido. Solicita autorización inmediatamente antes si implica datos locales, un proveedor externo, coste, escritura o una acción irreversible. Una clasificación local y de solo lectura no necesita esa autorización.

Si Karajan devuelve `requires_human_review`, pide revisión únicamente antes de la ejecución que produzca efectos; no repitas la clasificación ni pierdas el contexto al aprobar.

## Puertos y disponibilidad

El servidor local usa `http://127.0.0.1:8001` por defecto. `KARAJAN_URL` permite cambiarlo. El CLI recuerda la raíz del repositorio tras el primer `activate --start`, por lo que después funciona desde cualquier carpeta.

Si el CLI no está en `PATH`, usa el ejecutable del entorno virtual de Karajan o instala el paquete localmente con `pip install -e <ruta-del-repo-karajan>`. No recurras a `curl` salvo diagnóstico del propio CLI.
