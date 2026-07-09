# CLI de Karajan

Kit de comandos para manejar el harness KARAJAN desde terminal (o desde
cualquier agente de IA con acceso a shell), sin pasar por el dashboard web.

Funciona en dos modos:

- **Modo interactivo** (`karajan`, sin argumentos) — un REPL con comandos
  `/slash`, autocompletado y sin necesidad de comillas para los prompts,
  parecido a la interfaz de Claude Code.
- **Comandos directos** (`karajan classify "..."`, `karajan tasks list`, ...)
  — para scripting o para que un agente de IA los invoque uno a uno.

Ambos modos hablan por HTTP con el servidor Karajan (`KARAJAN_URL`, por
defecto `http://127.0.0.1:8000`), así que **funcionan desde cualquier
carpeta/repositorio**, no solo desde dentro de `karajan/` — el único paso que
necesita conocer dónde está el repo es arrancar el servidor (`--start`), y
eso se recuerda automáticamente después de la primera vez (ver más abajo).

## Puesta en marcha

El comando `karajan` vive dentro del `.venv` del repo. Cada vez que abras una
terminal nueva tienes que activar ese entorno antes de poder usarlo:

```powershell
cd C:\Users\tiand\Desktop\Workspace\karajan
.venv\Scripts\Activate.ps1
```

Si ves un error como `karajan: The term 'karajan' is not recognized...`, es
justo esto: el venv no está activado en esa sesión de PowerShell. El prompt
debería mostrar un prefijo `(.venv)` cuando sí lo está.

**Si `Activate.ps1` falla por política de ejecución** (`running scripts is
disabled on this system`), o si prefieres no activar el venv cada vez, usa la
ruta completa al ejecutable en su lugar:

```powershell
C:\Users\tiand\Desktop\Workspace\karajan\.venv\Scripts\karajan.exe activate --start
```

O crea un alias en tu perfil de PowerShell (`$PROFILE`) para no escribir la
ruta completa cada vez:

```powershell
Set-Alias karajan C:\Users\tiand\Desktop\Workspace\karajan\.venv\Scripts\karajan.exe
```

**Si el comando `karajan` no existe en absoluto** (ni con la ruta completa),
es que el paquete no está instalado en ese venv:

```powershell
cd C:\Users\tiand\Desktop\Workspace\karajan
.venv\Scripts\pip install -e .
```

## Modo interactivo (REPL)

```powershell
karajan
```

Al arrancar muestra un banner (logo ASCII + estado del harness + arquitectura
de Decisión + disponibilidad de proveedores + comandos básicos), en el mismo
espíritu que la pantalla de bienvenida de Claude Code. Los dos recuadros
tienen la misma altura y se apilan en vertical si la terminal es estrecha
(menos de 100 columnas).

Te deja en un prompt `karajan>`. Los comandos empiezan con `/`. **El texto
sin `/` clasifica Y delega en un solo paso** (no hace falta comillas), y va
imprimiendo el log del proceso a medida que avanza — clasificación, fase de
asignación/delegación (con el backend y modelo real usados) y el resultado
final de cada subtarea. `/classify` sigue disponible aparte para solo
previsualizar la clasificación sin gastar nada delegando:

```
karajan> /activate --start
karajan> Arregla el bug de paginación en el dashboard
· clasificando...
· clasificado task_id=tsk_... nivel=level_2_moderate score=1.8 modelo=cheap_or_medium_model
· delegando...
Log del proceso:
  [assign] sub_001 -> ...
  [delegate] sub_001:cheap_or_medium_model -> cli:ollama-qwen
  [validate] sub_001 -> aprobado
Resultado
┌──────────┬─────────┬─────────────┬───────────┬──────────────┐
│ subtask  │ backend │ modelo      │ estado    │ latencia_ms  │
└──────────┴─────────┴─────────────┴───────────┴──────────────┘

karajan> /classify Solo quiero ver cómo lo clasificaría, sin delegar
karajan> /assign tsk_abc123 --to claude-cli
karajan> /task_list
karajan> /stats_health
karajan> /json
karajan> /exit
```

Si `dispatch_mode` está en `queue` (despacho asíncrono por disponibilidad),
el texto libre hace polling y va avisando mientras la tarea espera un agente
libre, en vez de bloquear en silencio.

Cada comando tiene **dos formas equivalentes**, ambas con nombres completos
(sin abreviaciones crípticas):

- **forma larga**: `/<dominio> <subcomando> [args...]` — ej. `/tasks show tsk_123`
- **forma corta**: `/<dominio>_<subcomando> [args...]` — ej. `/task_show tsk_123`

```
/tasks list          == /task_list
/tasks show <id>     == /task_show <id>
/config set <k> <v>  == /config_set <k> <v>
/layout entities add ...        == /layout_entity_add ...
/layout groups add ...          == /layout_group_add ...
/layout membership set ...      == /layout_membership_set ...
/stats health        == /stats_health
/stats agents        == /stats_agents
/agents list          == /agent_list
/agents status         == /agent_status
```

`/activate`, `/classify`, `/assign`, `/json`, `/help` y `/exit` ya son una
sola palabra completa, así que no tienen una forma corta separada.

- **Tab** autocompleta ambas formas (menú difuso, como en Claude Code).
- `/json` alterna salida JSON cruda para el resto de la sesión.
- `/help` lista todos los comandos.
- Si tu terminal no soporta el autocompletado interactivo (p.ej. Git Bash sin
  winpty, o entrada por pipe), el REPL degrada solo a un modo de línea simple
  — sigue funcionando, solo sin el menú de sugerencias.

`karajan repl` hace lo mismo de forma explícita, por si algún día se añade
un subcomando que colisione con "sin argumentos".

## Comandos directos

Para scripting o para que un agente de IA los invoque uno a uno sin sesión
interactiva.

### Activar el harness

```powershell
karajan activate              # solo reporta si está arriba
karajan activate --start      # lo arranca si no lo está
```

La primera vez que `--start` localiza el repo (por estar dentro de él, o con
`--repo <ruta>`), recuerda esa ruta en `~/.karajan/config.json`. A partir de
ahí, `karajan activate --start` funciona **desde cualquier otra carpeta**
sin volver a indicarla.

### Clasificar y consultar tareas

```powershell
karajan classify "Arregla el bug de paginación en el dashboard"
karajan tasks list
karajan tasks show <task_id>
karajan tasks decisions <task_id>
karajan tasks search "paginación"
```

### Asignar una tarea a un agente concreto (salta el enrutado automático)

```powershell
karajan agents list                        # catálogo de proveedores
karajan assign <task_id> --to claude-cli    # fuerza ese proveedor
karajan assign --prompt "..." --to ollama-qwen   # clasifica + fuerza en un paso
karajan assign <task_id> --to <entity_id> --entity   # fuerza por id de la jerarquía, no por proveedor
```

### Configuración de la arquitectura de Decisión

```powershell
karajan layout show                                  # jerarquía completa
karajan layout entities list
karajan layout entities add --id e1 --role worker --provider claude-cli --tier 2
karajan layout groups add --id g1 --name "Tier A"
karajan layout membership set e1 g1 1                # Prio 1 = máxima prioridad

karajan config show
karajan config get orchestration.dispatch_mode
karajan config set orchestration.dispatch_mode queue
karajan config set-provider-pref medium_model claude-cli
```

### Estadísticas

```powershell
karajan stats health
karajan stats metrics
karajan stats agents          # coste/latencia/errores por proveedor
karajan stats dashboard --days 7
karajan stats leaderboard
```

### Agentes/proveedores

```powershell
karajan agents list           # catálogo estático
karajan agents status         # credenciales/disponibilidad en vivo
karajan agents setup ollama-qwen   # pasos guiados de instalación
karajan agents probe claude-cli    # ejecuta el comando de verificación
```

## Opciones globales

- `--json` — salida JSON cruda en vez de tablas.
- `--url` (o `KARAJAN_URL`) — si el servidor corre en otro puerto (default `http://127.0.0.1:8000`).
- `--token` (o `KARAJAN_TOKEN`) — si el servidor tiene auth activada.
- `karajan --help` / `karajan <grupo> --help` — ayuda completa de cualquier comando.

## Skill de Claude Code (`/karajan`)

Distinto del REPL de arriba: esto es para usar KARAJAN **dentro de una sesión
de Claude Code** (la terminal del propio Claude), no en una terminal aparte.

- `/karajan <tarea>` — invoca explícitamente la skill: Claude actúa como
  router padre (clasifica, registra la decisión en el harness, delega) en
  vez de resolver la tarea directamente.
- Sin comando: si la skill está instalada, Claude puede activarla también
  al recibir directamente una tarea de desarrollo no trivial, sin que hagas
  `/karajan` — depende del juicio del modelo sobre si la tarea encaja
  (`description` de la skill), no es una intercepción forzada de cada mensaje.

Instalación (copia `skills/karajan/` y `commands/karajan.md` a `~/.claude/`,
sin red, vía el mismo endpoint que usa el botón "Instalar" del dashboard):

```powershell
karajan agents probe claude-cli   # opcional: confirma que claude-cli está listo
curl -X POST http://127.0.0.1:8000/skills/karajan/install
```

o directamente desde Python dentro del repo:

```powershell
.venv\Scripts\python -c "from app import skills_catalog; print(skills_catalog.install_skill('karajan'))"
```

Hace falta reiniciar la sesión de Claude Code para que la skill nueva
aparezca en la lista de skills disponibles.
