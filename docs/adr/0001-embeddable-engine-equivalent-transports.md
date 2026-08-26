# ADR 0001: Karajan como motor embebible con transportes equivalentes

- Estado: aceptado, implementación incremental
- Fecha: 2026-08-26

## Contexto

La suite de `audit_code` ejecutaba llamadas a `http://127.0.0.1:8001` durante
tests ordinarios. La guarda de red solo impedía Ollama, por lo que un proceso
Karajan vivo podía convertir un fallo en un falso positivo y un puerto muerto
en un fallo aparentemente no reproducible.

El inventario inicial localizó las dependencias en `_exec_karajan`, el puente
HTTP, el dispatcher y los composition roots CLI/MCP. El porcentaje histórico
30–35% queda solo como orientación: el baseline verificable son esas llamadas,
los imports de transporte y los endpoints que aceptan routing externo.

## Decisión

`KarajanApplication` es la frontera operativa y delega en servicios de
clasificación, ejecución, consulta y administración. Embedded significa mismo
proceso y memoria, no modo reducido. FastAPI `/v1`, el cliente HTTP y el cliente
local son adaptadores distintos de los mismos comandos y vistas versionados.

`KarajanContainer(runtime, application)` registra recursos en `ExitStack`.
`KarajanHost(container)` es opcional y contiene únicamente lifecycle persistente
(scheduler/dispatcher cuando proceda). SQLite es el backend persistente actual;
tests pueden usar SQLite compartido en memoria. Postgres y garantías distribuidas
quedan fuera de alcance.

La idempotencia usa `(workspace_id, operation_name, idempotency_key)` y compara
un hash semántico. Estado, decisiones e outbox se confirman juntos. La entrega
del outbox es al menos una vez y se deduplica por `event_id`. Las llamadas a
providers ocurren fuera de la transacción; si no se confirma el resultado se
persiste `outcome_unknown` y no se reintenta automáticamente.

Los protocolos operativo, administrativo y de observabilidad son distintos.
Los overrides nunca forman parte de `ExecuteCommand`; requieren identidad y
capacidad explícita mediante `AuthorizationPort`. Telemetría/SSE no usa el
contrato de eventos de dominio.

## Reglas verificables

1. `app/application*` no importa FastAPI, HTTPX, Uvicorn, Typer, MCP o CLI.
2. `audit_code` depende de un gateway semántico y su suite normal no abre un
   socket de Karajan.
3. Toda lectura `/v1` de tareas está autenticada; liveness/readiness no exponen
   contenido.
4. Local y HTTP comparan decisiones semánticas, ignorando IDs y timestamps.
5. Un segundo propietario del mismo almacenamiento SQLite recibe un error; el
   lock es del sistema operativo y se libera al morir el propietario.
6. `KARAJAN_URL` selecciona HTTP por compatibilidad; embedded es el default de
   CLI/MCP y un conflicto de selectores es error.

## Evolución

Primero se preservan payloads y se crean seams. Cambios funcionales de
`/ingest`, overrides y routing siguen un ciclo de deprecación independiente y
telemetría sin prompts/contenido. Recuperación distribuida, leases, heartbeats,
Postgres y SaaS requieren otro ADR cuando exista un caso real.
