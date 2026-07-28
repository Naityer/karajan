# `agent_local_tools` — herramientas reales para agentes locales

Antes de esto, una subtarea de KARAJAN era **una única completación de texto a
ciegas**: se armaba un prompt de tres líneas, se metía por stdin a
`ollama run <modelo>` y se guardaba stdout. Un agente local no podía leer un
archivo, escribir un archivo ni ejecutar un comando. El libro de auditoría era
excelente, pero registraba texto, no trabajo.

Esta capa da a **cualquier** agente local — incluidos los modelos de Ollama sin
tool-calling nativo — la capacidad de realizar operaciones reales, confinadas y
auditadas fila a fila.

## Cómo se activa

Desactivada por defecto. En `data/active_config.json`:

```json
"agent_tools": {
  "enabled": true,
  "dry_run": true,
  "profile": "readonly",
  "default_workspace_root": "C:/ruta/a/tu/repo",
  "max_turns": 12,
  "max_tool_calls": 24,
  "max_wall_time_s": 900
}
```

O por tarea, en `POST /delegate-task`:

```json
{"task_id": "tsk_…", "workspace_root": "C:/ruta/al/repo", "agent_tools": "edit"}
```

`agent_tools: "off"` la desactiva para esa tarea aunque esté activada en config.

**Sin raíz de trabajo declarada, las herramientas quedan deshabilitadas.** Nunca
se usa el directorio del servidor como sustituto: ese es exactamente el defecto
que arrastra `claude-cli` hoy, donde el proceso hijo hereda el cwd de uvicorn y
acaba operando sobre el propio código de KARAJAN en vez del proyecto del usuario.

## El catálogo

Es dato, no código: una tupla congelada en `app/agent_tools/catalog.py`, con la
misma forma que `app/catalog.py` usa para proveedores. Consultable en
`GET /agent-tools` y `GET /agent-tools/profiles`.

| Herramienta | Riesgo | Qué hace |
|---|---|---|
| `list_dir`, `read_file`, `search`, `find_files` | READ | explorar el workspace |
| `write_file`, `edit_file` | WRITE | escribir y sustituir fragmentos exactos |
| `run_command` | EXECUTE | ejecutar un binario permitido, sin shell |
| `note`, `finish`, `ask_human`, `propose_context` | CONTROL | dirigir el bucle |

Perfiles: `minimal`, `readonly`, `doc`, `edit`, `build`. El riesgo máximo del
perfil decide si el run necesita firma humana.

### Dos decisiones que parecen raras y no lo son

**`edit_file` sustituye una cadena exacta; no es una herramienta de diff.** Un
modelo de 7b produce hunks de diff inválidos (recuentos de línea mal, contexto
que deriva) mucho más a menudo de lo que elige mal una cadena. Un hunk malo es
irrecuperable; una cadena mala devuelve `not_found`/`ambiguous` **citando las
líneas más parecidas del archivo**, sobre lo que el modelo sí puede actuar.

**`note` parece inútil y es la pieza que sostiene el resto.** Le da al modelo
confundido una acción *legal y gratis* en vez de emitir prosa — y la prosa fuera
de un bloque de herramienta es la primera causa de fallo de parseo en modelos
pequeños.

## El protocolo de texto

Los modelos con tool-calling nativo lo usan. Los demás responden con etiquetas:

```
<karajan:tool name="edit_file">
<param name="path">app/main.py</param>
<param name="old_text">
def foo():
    pass
</param>
</karajan:tool>
```

**Por qué etiquetas y no JSON.** Un modelo de 7b no escapa de forma fiable
contenido multilínea dentro de una cadena JSON: una comilla o una barra invertida
sueltas pierden el turno entero, sin nada que salvar. Con etiquetas el cuerpo se
toma literal entre delimitadores, así que un archivo con comillas, barras y
saltos de línea sobrevive byte a byte. El JSON se acepta igualmente como forma
*secundaria*, porque varios fine-tunes lo emiten de forma nativa.

El parser (`app/agent_tools/protocol.py`) es deliberadamente tolerante, y cada
tolerancia está porque los modelos locales hacen de verdad esa cosa: **gana el
último bloque** (repiten el ejemplo del prompt antes de su llamada real), quita
vallas markdown, acepta cierre implícito al final del mensaje, normaliza alias
(`<tool>`, `list_files`, `file`→`path`) y coerciona tipos.

Tras tres fallos de formato seguidos la sesión termina en `protocol_failure` y
**el último texto libre del modelo pasa a ser la salida de la subtarea**. Es la
garantía de compatibilidad: un fallo del bucle nunca es peor que la completación
a ciegas que sustituye.

## Seguridad

### Confinamiento

Todo camino pasa por `Workspace.resolve()`: se rechazan rutas absolutas, UNC y
bytes nulos antes de tocar el disco; se resuelve el ancestro existente más
profundo (los destinos de escritura aún no existen) y se compara con la raíz;
y se **vuelve a comprobar tras escribir**, porque un `run_command` de un turno
anterior pudo plantar un symlink entre la comprobación y la escritura.

### Rechazado de plano, sin flag que lo levante

- Cualquier ruta fuera de la raíz.
- **Lectura** de archivos con forma de credencial (`.env*`, `*.pem`, `*.key`,
  `id_rsa*`, `credentials*`, `.ssh/`, `.aws/`). Denegar la *lectura* y no solo la
  escritura es el control más fuerte de toda la capa: impide que el secreto entre
  en el contexto del modelo y, de ahí, en `run_events`.
- Internos de `.git/`.
- El propio `app/`, `data/` y `dashboard/static/` de KARAJAN si el workspace
  resulta ser este repositorio.

### `run_command`

Sin shell (`shlex.split` + `shell=False`); cualquier metacarácter se rechaza en
vez de escaparse. Allowlist de `argv[0]`; `npm install`, `pip install`,
`python -c` y `git push` exigen aprobación humana; `git reset`/`rebase` están
prohibidos. El entorno se limpia a `PATH`, `SYSTEMROOT`, `TEMP` y `LANG`, para
que nada de lo que lanza el agente herede las claves API del proceso uvicorn.
La salida se trunca por cabeza y cola y pasa por `agent_console._redact`.

### Sin sandbox de sistema operativo

**No lo hay, y conviene decirlo sin adornos.** Un modelo con `run_command` puede
hacer daño dentro de la allowlist y dentro del workspace. Esta versión compra la
mayor parte de la seguridad con confinamiento de rutas, ausencia de shell,
allowlist de binarios, entorno limpiado, denegación de lectura de secretos,
presupuestos y `dry_run`. Contención de *procesos* no hay. Un contenedor o un Job
Object de Windows es la respuesta correcta a medio plazo.

### Aprobación humana: la que ya existía

Un perfil con herramientas WRITE/EXECUTE marca
`classification.requires_human_review`; a partir de ahí actúa el
`_pre_execution_gate` de siempre, y `POST /tasks/{id}/approve-review` libera la
ejecución retenida. Cero endpoints nuevos, cero semánticas de puerta paralelas.

## Observabilidad

Las tablas `run_events` y `artifacts` se enviaron vacías como preparación de
Fase 1. Esta capa es la que finalmente las llena:

| Evento | Cuándo |
|---|---|
| `agent_started` | perfil, workspace, modo y presupuesto iniciales |
| `model_turn` | por turno: cómo se parseó, latencia, tokens |
| `tool_call` / `tool_result` | por llamada: parámetros redactados, ok, código de error, bytes |
| `tool_denied` | una llamada rechazada por política |
| `parse_error` | el modelo no respetó el formato |
| `budget_exhausted`, `awaiting_approval`, `agent_finished` | cierre |

`artifacts` recibe una fila por archivo tocado, con la ruta **relativa al
workspace** (así el libro es portable y la ruta personal del operador no entra
en la auditoría) y el sha256 posterior a la escritura. En `dry_run` se registran
igualmente como `file_planned`, para poder inspeccionar qué *haría* antes de
conceder escritura.

Se leen en `GET /tasks/{id}/runs`, `GET /runs/{id}/events` y
`GET /tasks/{id}/artifacts`.

## Trazas de ejemplo (reales)

Sesión con `llama3.2:3b`, perfil `readonly`, `dry_run`:

```
AGENT_STARTED  profile=readonly tool_mode=text
MODEL_TURN  #1 parsed=text 13314ms
TOOL_CALL   read_file {"path": "src/main.py"}
TOOL_RESULT read_file ok=False err=not_found :: 'no existe: src/main.py'
MODEL_TURN  #2 parsed=text 4356ms
TOOL_CALL   find_files {"glob": "**/*.py"}
TOOL_RESULT find_files ok=True :: 'calc.py'
MODEL_TURN  #3 parsed=text 13873ms
TOOL_CALL   finish
AGENT_FINISHED status=completed turns=3 tool_calls=3
```

Un modelo de 3b, tres turnos, cero errores de formato, y recuperándose solo de un
`not_found` cambiando de estrategia. Eso es lo que antes era una frase de prosa.

## Puente al chat web para documentación

El flujo pedido, entero:

1. **Selección local.** Una sesión con el perfil `doc` (solo lectura + el
   terminal `propose_context`) explora el repo y decide qué archivos importan.
   No es código nuevo: es el primer uso real del bucle.
2. **Empaquetado.** `POST /handoff/packs` lee esa selección **volviendo a
   pasarla por los guardas del workspace** — la selección viene de un modelo, y
   las reglas de contención y de secretos tienen que aguantar también *de
   salida*, porque esto está a punto de pegarse en un chat de terceros. Produce
   un Markdown con presupuesto de caracteres y secciones fijas.
3. **Chat web.** Copias el pack a ChatGPT o Claude. El pack incluye las
   instrucciones de formato para que la respuesta vuelva lista para pegar: sin
   preámbulo y sin envolverla en un bloque de código.
4. **Vuelta.** `POST /handoff/packs/{id}/result` ingiere la respuesta.
   `GET /handoff/packs?status=ready` es lo que Atlas consulta para encontrar
   documentos que aceptar.

Packs y resultados se registran en `artifacts` (`context_pack`, `doc_result`),
así que aparecen en `GET /tasks/{id}/artifacts` y en el Monitor sin fontanería
adicional.

**Por qué manual-first y no automatización de navegador.** No sale ninguna
credencial de la máquina, nada depende de que la interfaz de un tercero siga
igual la semana que viene, y el modelo caro se usa donde de verdad le sale
barato al operador. La automatización con Playwright queda como modo opcional.

## Observado al ejecutarlo de verdad

Con `llama3.2:3b`, perfil `readonly`: tres turnos, cero errores de formato, y se
recuperó solo de un `not_found` cambiando de estrategia.

Con el mismo modelo y el perfil `doc`, en cambio, alucinó un directorio `src/`
inexistente y se quedó repitiendo la misma llamada. De ahí salieron dos
mecanismos que ahora están en el bucle:

- **Rechazo de llamadas repetidas idénticas.** Volver a ejecutarlas gasta un
  turno y no enseña nada; se devuelve una observación que dice explícitamente
  que ya se hizo y que toca cambiar de estrategia o terminar.
- **Aviso de cierre.** Cuando quedan dos turnos, la cabecera del turno pasa de
  informar del presupuesto a ordenar que se cierre con una herramienta terminal.

Con `llama3.1:8b` el flujo `doc` sí completa: explora, anota y propone contexto.
Su primer `propose_context` escribió las dos rutas como `calc.py(cli.py)`; el
error le volvió como observación y lo corrigió al turno siguiente. De ahí salió
la tercera tolerancia: `propose_context` acepta listas separadas por saltos de
línea, comas, punto y coma, paréntesis, corchetes, guiones y backticks.

La conclusión práctica: **3b sirve para lectura guiada, 8b para trabajo
autónomo.** El perfil y el presupuesto son la palanca para elegir.
