"""System prompt construction, rendered straight from `ToolSpec` data.

Nothing here hand-writes a tool description: the prompt is a projection of the
catalog, so a tool cannot drift from its documentation.

Two things are re-rendered on **every** turn rather than stated once:

- the remaining budget ("turnos restantes: 7"), which visibly reduces dithering
  on small models — they stop exploring when they can see the clock;
- a short protocol reminder every few turns, because a 7b model's adherence to
  an instruction decays with distance from it.
"""

from __future__ import annotations

from app.agent_tools.budget import RunBudget
from app.agent_tools.spec import ToolSpec
from app.agent_tools.workspace import Workspace

PROTOCOL_REMINDER = (
    "Recuerda: responde con UN solo bloque <karajan:tool name=\"...\">…</karajan:tool>, "
    "sin texto por fuera. Un parametro por <param name=\"...\">valor</param>."
)


def render_tool(spec: ToolSpec) -> str:
    lines = [f"### {spec.signature()}", spec.summary]
    for param in spec.params:
        required = "obligatorio" if param.required else f"opcional (por defecto {param.default!r})"
        description = f" — {param.description}" if param.description else ""
        lines.append(f"  - {param.name} ({param.type}, {required}){description}")
    lines.append(f"  Devuelve: {spec.returns}")
    if spec.failure_modes:
        lines.append("  Errores: " + "; ".join(spec.failure_modes))
    return "\n".join(lines)


def build_system(
    tools: list[ToolSpec],
    workspace: Workspace,
    budget: RunBudget,
    *,
    native_tools: bool = False,
) -> str:
    """The system message. `native_tools=True` omits the text protocol, because
    the model receives the schema through the provider's own `tools` array and
    two competing formats is how a model ends up emitting neither."""
    header = [
        "Eres un agente de KARAJAN trabajando sobre un repositorio real.",
        "Actuas usando herramientas: no describas lo que harias, hazlo.",
        "",
        f"Workspace (unica zona a la que tienes acceso): {workspace.root}",
    ]
    if workspace.dry_run:
        header.append(
            "MODO SIMULACION: las escrituras y comandos NO se aplican; se te devuelve "
            "el diff de lo que ocurriria. Trabaja igual."
        )
    header += [
        "",
        "Reglas:",
        "- Toda ruta es relativa al workspace. Las rutas absolutas se rechazan.",
        "- Los archivos con aspecto de credenciales (.env, *.pem, claves) no se pueden ni leer.",
        "- Lee antes de editar. Copia el fragmento exacto que devuelve read_file, sin los numeros de linea.",
        "- Una sola herramienta por mensaje.",
        "- Cuando termines, llama a una herramienta terminal para cerrar la subtarea.",
        "",
        "## Herramientas",
        "",
    ]
    body = "\n\n".join(render_tool(spec) for spec in tools)

    footer = ["", f"Presupuesto: {budget.remaining_summary()}."]
    if not native_tools:
        footer += [
            "",
            "## Formato de respuesta",
            "",
            "Responde EXACTAMENTE con un bloque como este, sin texto alrededor:",
            "",
            tools[0].example if tools else "",
            "",
            "El contenido de cada <param> se toma literal, con sus saltos de linea e indentacion.",
        ]
    return "\n".join(header) + body + "\n".join(footer)


def turn_header(
    budget: RunBudget, *, remind_protocol: bool, wrap_up_tools: list[str] | None = None
) -> str:
    """Prefix prepended to each user-side turn to keep the budget in view.

    `wrap_up_tools` turns the countdown into an instruction near the end. Small
    models keep exploring straight into the budget wall unless told, in as many
    words, that it is time to finish.
    """
    parts = [f"[{budget.remaining_summary()}]"]
    if wrap_up_tools:
        parts.append(
            "TE QUEDAN MUY POCOS TURNOS. Cierra ya con una de estas herramientas: "
            + ", ".join(f"`{name}`" for name in wrap_up_tools)
            + "."
        )
    if remind_protocol:
        parts.append(PROTOCOL_REMINDER)
    return "\n".join(parts)


def observation_message(tool: str, ok: bool, observation: str) -> str:
    status = "OK" if ok else "ERROR"
    return f"[{tool} · {status}]\n{observation}"


def initial_user_message(original_prompt: str, subtask_name: str, validation: str) -> str:
    """Same three facts the one-shot path sends, framed as a job to carry out."""
    return (
        f"{original_prompt}\n\n"
        f"Subtarea: {subtask_name}\n"
        f"Criterio de validacion: {validation}\n\n"
        "Empieza explorando lo que necesites y termina llamando a una herramienta terminal."
    )
