"""The tool catalog, as data — the same shape `app/catalog.py` uses for providers.

Frozen module-level tuple plus accessors, no side effects at import. That is
what lets the catalog be rendered in the dashboard, diffed in review, and tested
without a model anywhere near it.

Two choices worth defending, because they look wrong at a glance:

- **`edit_file` replaces an exact string; it is not a diff/patch tool.** A 7b
  model produces invalid unified-diff hunks (wrong line counts, drifting
  context) far more often than it picks a wrong string to match. A bad hunk is
  unrecoverable; a bad match returns `not_found`/`ambiguous` with the nearest
  lines quoted, which the model can act on.
- **`note` looks useless and is load-bearing.** It gives a confused model a
  *legal, zero-cost* action instead of emitting prose, and prose outside a tool
  block is the single largest source of parse failures on small local models.
"""

from __future__ import annotations

from app.agent_tools.spec import RiskTier, ToolParam, ToolSpec

_CATALOG: tuple[ToolSpec, ...] = (
    # ── READ ────────────────────────────────────────────────────────────────
    ToolSpec(
        name="list_dir",
        summary="Lista el contenido de un directorio del workspace.",
        params=(
            ToolParam("path", required=False, default=".", description="Ruta relativa al workspace."),
            ToolParam("depth", "integer", required=False, default=1, description="Niveles a descender (1-3)."),
        ),
        returns="Arbol de rutas relativas, directorios primero, maximo 200 entradas.",
        risk=RiskTier.READ,
        failure_modes=(
            "not_found: la ruta no existe",
            "outside_workspace: la ruta se sale del workspace",
            "too_large: demasiadas entradas; acota con `path` o baja `depth`",
        ),
        example='<karajan:tool name="list_dir">\n<param name="path">src</param>\n</karajan:tool>',
    ),
    ToolSpec(
        name="read_file",
        summary="Lee una ventana de un archivo de texto, con numeros de linea.",
        params=(
            ToolParam("path", description="Ruta relativa al workspace."),
            ToolParam("start_line", "integer", required=False, default=1),
            ToolParam("max_lines", "integer", required=False, default=400),
        ),
        returns="Lineas numeradas; si se corta, avisa con [truncado: N lineas mas].",
        risk=RiskTier.READ,
        failure_modes=(
            "not_found: el archivo no existe",
            "denied: el archivo parece contener credenciales y no se puede leer",
            "too_large: el archivo excede el limite; usa start_line/max_lines",
        ),
        example='<karajan:tool name="read_file">\n<param name="path">app/main.py</param>\n<param name="start_line">1</param>\n</karajan:tool>',
    ),
    ToolSpec(
        name="search",
        summary="Busca un texto o expresion regular en los archivos del workspace.",
        params=(
            ToolParam("pattern", description="Texto literal, o regex si regex=true."),
            ToolParam("glob", required=False, default="**/*", description="Filtro de rutas."),
            ToolParam("regex", "boolean", required=False, default=False),
            ToolParam("max_results", "integer", required=False, default=50),
        ),
        returns="Lineas 'ruta:linea: texto', una por coincidencia.",
        risk=RiskTier.READ,
        failure_modes=("bad_params: la expresion regular no es valida",),
        example='<karajan:tool name="search">\n<param name="pattern">def delegate</param>\n</karajan:tool>',
    ),
    ToolSpec(
        name="find_files",
        summary="Lista archivos del workspace que casan con un patron glob.",
        params=(
            ToolParam("glob", description="Patron glob, p.ej. **/*.py"),
            ToolParam("max_results", "integer", required=False, default=100),
        ),
        returns="Rutas relativas, una por linea.",
        risk=RiskTier.READ,
        failure_modes=("bad_params: patron glob vacio o invalido",),
        example='<karajan:tool name="find_files">\n<param name="glob">**/*.py</param>\n</karajan:tool>',
    ),
    # ── WRITE ───────────────────────────────────────────────────────────────
    ToolSpec(
        name="write_file",
        summary="Escribe un archivo completo. Crea los directorios que falten.",
        params=(
            ToolParam("path", description="Ruta relativa al workspace."),
            ToolParam("content", multiline=True, description="Contenido completo del archivo."),
            ToolParam("overwrite", "boolean", required=False, default=False),
        ),
        returns="Bytes escritos y hash sha256 del resultado.",
        risk=RiskTier.WRITE,
        failure_modes=(
            "conflict: el archivo ya existe y overwrite=false",
            "outside_workspace: la ruta se sale del workspace",
            "denied: la ruta esta protegida (secretos, .git, el propio KARAJAN)",
            "too_large: el contenido excede el limite por archivo",
        ),
        example='<karajan:tool name="write_file">\n<param name="path">notas.md</param>\n<param name="content">\n# Notas\n</param>\n</karajan:tool>',
    ),
    ToolSpec(
        name="edit_file",
        summary="Sustituye un fragmento exacto de un archivo por otro.",
        params=(
            ToolParam("path", description="Ruta relativa al workspace."),
            ToolParam("old_text", multiline=True, description="Fragmento exacto a sustituir, tal cual aparece."),
            ToolParam("new_text", multiline=True, required=False, default="", description="Texto de reemplazo."),
            ToolParam("count", "integer", required=False, default=1, description="Ocurrencias a sustituir."),
        ),
        returns="Diff unificado de lo que ha cambiado.",
        risk=RiskTier.WRITE,
        failure_modes=(
            "not_found: `old_text` no aparece en el archivo (se citan las lineas mas parecidas)",
            "ambiguous: aparece mas veces que `count`; amplia `old_text` o sube `count`",
            "denied: la ruta esta protegida",
        ),
        example='<karajan:tool name="edit_file">\n<param name="path">app/main.py</param>\n<param name="old_text">\ndef foo():\n    pass\n</param>\n<param name="new_text">\ndef foo():\n    return 1\n</param>\n</karajan:tool>',
    ),
    # ── EXECUTE ─────────────────────────────────────────────────────────────
    ToolSpec(
        name="run_command",
        summary="Ejecuta un comando permitido dentro del workspace. Sin shell.",
        params=(
            ToolParam("command", description="Comando y argumentos, p.ej. 'pytest -q'."),
            ToolParam("timeout_s", "integer", required=False, default=60),
        ),
        returns="Codigo de salida y salida combinada, truncada por cabeza y cola.",
        risk=RiskTier.EXECUTE,
        failure_modes=(
            "denied: el binario no esta en la lista permitida, o el comando usa metacaracteres de shell",
            "timeout: el comando ha excedido timeout_s",
            "not_found: el binario no esta instalado",
        ),
        example='<karajan:tool name="run_command">\n<param name="command">pytest -q</param>\n</karajan:tool>',
    ),
    # ── CONTROL ─────────────────────────────────────────────────────────────
    ToolSpec(
        name="note",
        summary="Anota un razonamiento sin tocar nada. Usalo si no sabes que hacer todavia.",
        params=(ToolParam("text", multiline=True, description="Lo que estas razonando."),),
        returns="Confirmacion.",
        risk=RiskTier.CONTROL,
        example='<karajan:tool name="note">\n<param name="text">Necesito ver el router antes de editar.</param>\n</karajan:tool>',
    ),
    ToolSpec(
        name="finish",
        summary="Termina la subtarea. Resume lo que has hecho.",
        params=(
            ToolParam("summary", multiline=True, description="Que has hecho y como ha quedado."),
            ToolParam("status", required=False, default="success", description="success | failed"),
        ),
        returns="Termina la sesion.",
        risk=RiskTier.CONTROL,
        terminal=True,
        example='<karajan:tool name="finish">\n<param name="summary">He corregido el validador y los tests pasan.</param>\n</karajan:tool>',
    ),
    ToolSpec(
        name="ask_human",
        summary="Detiene la sesion y pide una decision a la persona responsable.",
        params=(ToolParam("question", multiline=True, description="La decision que necesitas."),),
        returns="Termina la sesion a la espera de aprobacion humana.",
        risk=RiskTier.CONTROL,
        terminal=True,
        example='<karajan:tool name="ask_human">\n<param name="question">Hay dos migraciones en conflicto, cual mantengo?</param>\n</karajan:tool>',
    ),
    ToolSpec(
        name="propose_context",
        summary="Termina proponiendo los archivos relevantes para documentar lo pedido.",
        params=(
            ToolParam("paths", multiline=True, description="Una ruta relativa por linea."),
            ToolParam("rationale", multiline=True, required=False, default="", description="Por que estos y no otros."),
        ),
        returns="Termina la sesion con la seleccion de contexto.",
        risk=RiskTier.CONTROL,
        terminal=True,
        failure_modes=("not_found: alguna ruta propuesta no existe en el workspace",),
        example='<karajan:tool name="propose_context">\n<param name="paths">\napp/main.py\napp/delegation.py\n</param>\n<param name="rationale">Son el punto de entrada y el motor.</param>\n</karajan:tool>',
    ),
)

_BY_NAME = {tool.name: tool for tool in _CATALOG}

# Permission sets. `minimal` exists for models too small to hold a real catalog
# in context; `doc` is the read-only profile behind the documentation handoff.
PROFILES: dict[str, tuple[str, ...]] = {
    "minimal": ("read_file", "note", "finish"),
    "readonly": ("list_dir", "read_file", "search", "find_files", "note", "finish", "ask_human"),
    "doc": ("list_dir", "read_file", "search", "find_files", "note", "propose_context"),
    "edit": (
        "list_dir", "read_file", "search", "find_files",
        "write_file", "edit_file", "note", "finish", "ask_human",
    ),
    "build": (
        "list_dir", "read_file", "search", "find_files",
        "write_file", "edit_file", "run_command", "note", "finish", "ask_human",
    ),
}

_RISK_ORDER = (RiskTier.CONTROL, RiskTier.READ, RiskTier.WRITE, RiskTier.EXECUTE)


def all_tools() -> list[ToolSpec]:
    return list(_CATALOG)


def get_tool(name: str) -> ToolSpec | None:
    return _BY_NAME.get(name)


def profile_names() -> list[str]:
    return list(PROFILES)


def tools_for_profile(profile: str) -> list[ToolSpec]:
    """Specs granted by `profile`, in catalog order. Unknown profile → empty."""
    granted = PROFILES.get(profile)
    if granted is None:
        return []
    return [tool for tool in _CATALOG if tool.name in granted]


def max_risk(profile: str) -> RiskTier:
    """Highest risk tier a profile can reach — the input to the approval policy."""
    tools = tools_for_profile(profile)
    if not tools:
        return RiskTier.CONTROL
    return max((tool.risk for tool in tools), key=_RISK_ORDER.index)


def terminal_tools(profile: str) -> list[str]:
    return [tool.name for tool in tools_for_profile(profile) if tool.terminal]
