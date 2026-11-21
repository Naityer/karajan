# Análisis de tareas (histórico etiquetado)

Infraestructura de datos para que dpw7 (evolución de perfiles) y cualquier análisis posterior partan de un histórico de tareas con **etiquetas y métricas coherentes**. El motor vive aquí (`atlas/src/analisis/`, puerto TS que ejecuta Atlas dev); la operación (lanzar, programar, ver el estado) está en Atlas dev, ver `docs/analisis-tareas.md` de ese repo.

## Qué hace

Para cada tarea del registro de Atlas dev (`<baúl>/registros/validadas/<id>_<slug>/tarea.json`, escrito al validar la tarea; contrato `version: 1`) y, opcionalmente, para las tareas terminadas de la cola que aún no están en el registro:

1. **Observa**: lee tal cual lo que hay (estado, validación humana, agente y modelo de la cabecera, tokens, coste, vueltas, duración activa, correcciones, clasificación de la hoja). Nada se infiere aquí.
2. **Etiqueta** tres ejes con la taxonomía cerrada: reglas deterministas primero (la hoja ya trae clasificación; el tipo de la cola) y, para lo que falte, un modelo.
3. **Normaliza**: sinónimos y escalas distintas (`media`, `moderate`, `level_3_moderate`, `3`) van al mismo término. Lo que no está en la taxonomía queda `desconocido`, lo genérico queda `ambiguo`, y siempre se conserva el original. Nunca se inventa un valor.
4. **Guarda** `analisis.json` junto a `tarea.json` (escritura atómica). No toca `tarea.json` y **no copia el transcript** (pesa MB y lleva datos de cuenta). Las tareas de la cola sin carpeta en el registro usan `<registros>/sin-registro/<id>/`.

## Modelo de datos (`analisis.json`)

```
{ esquema, tarea_id,
  proceso:   { estado: ok|pendiente|fallido, intentos, error, ultimo_intento, version_objetivo },
  actual:    { observado: {...}, inferido: { etiquetas[], notas }, procedencia: {...} } | null,
  historial: [ análisis de versiones anteriores ] }
```

- **`observado`** (hechos): `resultado` (`validada`, `completada_sin_validar`, `fallida`, `descartada`, `abierta`, `desconocido`), `validada` (true/false/null), `agente`, `modelo`, `perfil`, `duracion_activa_ms`, `vueltas`, `tokens`, `coste_usd`, `correcciones {total, redirecciones}`, `eventos`, `clasificacion_origen`, `origen` (`registro`|`cola`).
- **`inferido`** (opinión): una etiqueta por eje con `valor`, `estado` (`canonico|ambiguo|desconocido`), `original`, `fuente` (`regla|modelo`), `confianza` (solo si la da el modelo) y `razon`.
- **`procedencia`**: `version_analisis`, `taxonomia_version`, `proveedor` y `modelo` que respondieron (`reglas` si no hizo falta modelo), `prompt_hash`, `huella_origen`, `fecha`.

### Límites: qué no se puede obtener

| Campo | Situación |
|---|---|
| `perfil` | La cola de Atlas dev no guarda el perfil de Karajan que decidió: casi siempre `null`. La atribución está en `runs.profile_id` de la base de Karajan (dpw7), no en el registro. |
| `coste_usd` | `null` si ninguna vuelta lo trae (Codex no lo informa). No se rellena con 0. |
| `tokens`, `duracion_activa_ms` | `null` en las tareas sin métricas (p. ej. las de pruebas e2e). Se analizan igualmente y salen sin esos datos. |
| `score` de Karajan | No existe en el registro. `exportar` da `ok` (validada→true, fallida→false, resto según `validada`) y deja el resto a dpw7. |
| Duración | Se usa el tiempo en `ejecutando`, no `porEstado.borrador`, que puede ser de meses. |

## Taxonomía (`atlas/src/analisis/taxonomia.ts`, `TAXONOMIA_VERSION`)

| Eje | Términos |
|---|---|
| `nivel` | trivial, simple, moderada, compleja, critica (equivale a `complexity_score` 0-5 de Karajan agrupado) |
| `dominio` | frontend, backend, datos, infra, qa, diseno, docs, seguridad, planificacion, ia |
| `tipo` | bug, feature, mejora, refactor, investigacion, mantenimiento, prueba |

Cada término lleva definición y alias; un test comprueba que no haya alias repetidos a distinto destino. `kj analisis taxonomia` la imprime. **Cambiar términos o alias exige subir `TAXONOMIA_VERSION` y `VERSION_ANALISIS`**: así lo ya analizado se reconoce como antiguo.

## Idempotencia, versiones y fallos

- Clave: `(tarea, version_analisis)` más la **huella del origen**. Procesar de nuevo una tarea ya analizada con la misma versión y el mismo contenido se omite (sin llamar al modelo). Si cambia el contenido (p. ej. se rechaza la validación) o la versión, se rehace; el análisis de otra versión pasa a `historial`. `--forzar` sustituye el de la misma versión sin duplicarlo.
- **Fallos**: registro inaccesible, cola caída, `tarea.json` corrupto, modelo caído o respuesta inválida, escritura fallida. Cada uno se anota en la bitácora (`<datos>/analisis/bitacora.jsonl`) y en `proceso` de la tarea, sin tocar su análisis previo. Sin ningún modelo disponible la tarea queda `pendiente` (no cuenta como intento). Un modelo que responde basura cuenta intentos y, al llegar a `maxIntentos`, se deja de reintentar hasta subir la versión o forzar.
- `kj analisis reintentar` (o «Procesar» en Atlas dev) vuelve a pasar por lo pendiente y lo fallido.

## Modelos: orden y condiciones (verificado en este equipo, 2026-11-20)

La cadena es configurable; por defecto **Ollama local → Gemini (`agy`) de respaldo**.

| Proveedor | Estado verificado | Condiciones |
|---|---|---|
| `ollama` (`qwen2.5:14b`) | Instalado. También `llama3.1:8b`, `deepseek-r1:32b`, `qwen2.5-coder:7b`. | Local, sin coste de tokens; consume CPU/GPU y tiempo (hasta `timeoutMs`). Primero. |
| `agy` (Gemini, Antigravity CLI 1.5.x) | Instalado y con sesión (`agy models` lista modelos). | Cuenta Google personal. **Los límites y el coste del plan no son consultables desde la CLI y no se han podido confirmar**: se trata como recurso con cuota. Solo respaldo, apagable con `permitirGemini=false` y con tope `maxGeminiPorEjecucion` (5). Se sondea (`agy models`) antes de cada uso. |
| `claude-cli`, `codex` | Instalados. | De pago/suscripción: **no** están en la cadena por defecto; solo se usan en la destilación si se configuran. |

Si nadie está disponible, la tarea queda `pendiente`; nunca se etiqueta sin modelo ni se inventa.

### Destilación (modelo de mayor capacidad, configurable y apagada por defecto)

Con `destilacion.activa=true`, un modelo mayor (`proveedor`/`modelo` configurables, por defecto `claude-cli`/`opus`) revisa los valores `desconocido`/`ambiguo` acumulados y propone alias, términos nuevos o ignorar. Solo hay propuesta cuando hay evidencia suficiente (`minimoValores`); lo inventado o duplicado se descarta. **Nunca cambia la taxonomía**: la propuesta se guarda en `<datos>/analisis/destilacion.json` y sale como **borrador** de Atlas dev (pasarela de borradores) para que la persona decida.

## Configuración (`<datos>/analisis.json`)

| Campo | Defecto | Significado |
|---|---|---|
| `dirRegistro` | `null` | Carpeta `registros/`; `null` = `ATLAS_REGISTRO_DIR`, o `DOCS_ROOT`/`ATLAS_VAULT` + `registros`, o `<ATLAS_WORKSPACE>/../atlas-vault/registros`. |
| `cadena` | ollama (qwen2.5:14b), agy | Orden de proveedores; cada uno con `activo`. |
| `permitirGemini`, `maxGeminiPorEjecucion` | true, 5 | Permiso y tope de llamadas a Gemini por pasada. |
| `timeoutMs`, `limitePorEjecucion`, `maxIntentos` | 180000, 20, 5 | |
| `usarCola` | true | Mirar también las tareas terminadas de la cola de Atlas dev. |
| `destilacion` | apagada | `activa`, `proveedor`, `modelo`, `minimoValores`. |

Un valor inválido vuelve al defecto (una errata no rompe la rutina). `kj analisis config [--set '<json>']`; cambiarla en producción exige tarea aceptada.

## API y CLI

`POST /analisis/procesar {limite?, forzar?, solo_registro?}` · `GET /analisis/estado` · `GET /analisis/tarea/:id` · `GET /analisis/taxonomia` · `GET /analisis/export` · `POST /analisis/destilar` · `GET|PUT /analisis/config`. Solo hay una pasada a la vez (409 si hay otra).

`kj analisis estado | procesar [--limite N] [--forzar] [--solo-registro] | reintentar | tarea <id> | taxonomia | exportar | destilar | config`.

## Datos para dpw7

`GET /analisis/export` devuelve una muestra por tarea analizada: `perfil`, `agente`, `modelo`, `nivel`, `dominio`, `tipo`, `resultado`, `ok`, `coste_usd`, `duracion_activa_ms`, `redirecciones`, `version_analisis`, `taxonomia_version`, `proveedor`. Los valores desconocidos van como `null`, no se omiten. Este trabajo no cambia el algoritmo genético ni crea o activa perfiles. Pendiente al integrar: dpw7 consume `task_logs.db`; unir ambas fuentes (por `tarea` y `perfil`) es decisión de esa tarea.

## Pruebas

`npm test --prefix atlas`: `analisis-clasificacion.test.ts` (taxonomía, datos observados, clasificación y selección de proveedor con backends simulados) y `analisis-rutina.test.ts` (flujo completo con cola, registro y modelo simulados; persistencia; idempotencia y versiones; fallos y reintento; exportación; destilación). La rutina de análisis no usa procesos reales en los tests.
