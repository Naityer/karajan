"""`run_command`: the only tool that starts a process.

Four containment rules, none of them optional:

1. **No shell.** `shlex.split` + `subprocess.run(argv, shell=False)`. Any shell
   metacharacter is refused outright rather than escaped — escaping is where
   command-injection defenses go to die.
2. **argv[0] allowlist.** Plus a subcommand denylist for the operations an agent
   has no business doing unsupervised (`git push`, `git reset --hard`,
   `pip install`, `python -c`).
3. **Scrubbed environment.** The uvicorn process holds every provider API key;
   nothing an agent spawns inherits them.
4. **Redacted output.** Whatever comes back goes through
   `agent_console._redact` before it reaches the model or the trace.

This is path- and process-argument containment, not a sandbox. A permitted
command can still do damage inside the workspace. That is documented, not
papered over.
"""

from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import time

from app.agent_console import _redact
from app.agent_tools.spec import ToolResult
from app.agent_tools.workspace import Workspace

# Anything that only means something to a shell. Present ⇒ refused.
SHELL_METACHARACTERS = frozenset('|&;<>`$()!*?[]{}~\n\r')

DEFAULT_ALLOWED_BINARIES: tuple[str, ...] = (
    "git", "python", "python3", "pip", "pytest", "node", "npm", "pnpm", "yarn",
    "ruff", "mypy", "black", "eslint", "tsc", "go", "cargo", "dotnet", "make",
    "ls", "cat", "rg", "grep", "find", "echo",
)

# (binary, first-arg prefix) pairs that need explicit human approval.
NEEDS_APPROVAL: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("git", ("push", "remote", "clean")),
    ("npm", ("install", "i", "publish")),
    ("pnpm", ("install", "add", "publish")),
    ("yarn", ("add", "install", "publish")),
    ("python", ("-c",)),
    ("python3", ("-c",)),
    ("pip", ("install",)),
)

# Refused outright: destructive and unrecoverable from an agent's position.
FORBIDDEN: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("git", ("reset", "rebase", "filter-branch")),
)

MAX_OUTPUT_CHARS = 48_000
SAFE_ENV_KEYS = ("PATH", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL", "HOME")


def _scrubbed_env() -> dict[str, str]:
    env = {key: os.environ[key] for key in SAFE_ENV_KEYS if key in os.environ}
    env.setdefault("PYTHONIOENCODING", "utf-8")
    return env


def _truncate(text: str) -> str:
    """Head + tail, so both the command's intent and its verdict survive."""
    if len(text) <= MAX_OUTPUT_CHARS:
        return text
    head = MAX_OUTPUT_CHARS * 2 // 3
    tail = MAX_OUTPUT_CHARS - head
    omitted = len(text) - MAX_OUTPUT_CHARS
    return f"{text[:head]}\n[…{omitted} caracteres omitidos…]\n{text[-tail:]}"


def _classify(argv: list[str], allowed: tuple[str, ...]) -> str | None:
    """Reason the command is refused, or None."""
    binary = argv[0]
    if "/" in binary or "\\" in binary or ".." in binary:
        return f"usa el nombre del binario, no una ruta: {binary!r}"
    if "=" in binary:
        return "no se admiten asignaciones de variables de entorno delante del comando"
    if binary not in allowed:
        return f"'{binary}' no esta en la lista permitida. Permitidos: {', '.join(sorted(allowed))}"

    rest = argv[1:]
    first = rest[0] if rest else ""
    for name, prefixes in FORBIDDEN:
        if binary == name and first in prefixes:
            return f"'{binary} {first}' esta prohibido: es destructivo y no se puede deshacer desde aqui"
    for name, prefixes in NEEDS_APPROVAL:
        if binary == name and first in prefixes:
            return (
                f"'{binary} {first}' requiere aprobacion humana explicita "
                "(instala software o ejecuta codigo arbitrario)"
            )
    return None


def run_command(
    workspace: Workspace,
    command: str,
    timeout_s: int = 60,
    *,
    allowed_binaries: tuple[str, ...] = DEFAULT_ALLOWED_BINARIES,
) -> ToolResult:
    raw = (command or "").strip()
    if not raw:
        return ToolResult.failure("run_command", "bad_params", "el comando esta vacio")

    illegal = SHELL_METACHARACTERS.intersection(raw)
    if illegal:
        return ToolResult.failure(
            "run_command", "denied",
            f"el comando contiene metacaracteres de shell ({''.join(sorted(illegal))}) y no se ejecuta en un shell. "
            "Lanza un solo programa con sus argumentos.",
        )

    try:
        argv = shlex.split(raw, posix=os.name != "nt")
    except ValueError as exc:
        return ToolResult.failure("run_command", "bad_params", f"no se pudo interpretar el comando: {exc}")
    if not argv:
        return ToolResult.failure("run_command", "bad_params", "el comando esta vacio")

    refusal = _classify(argv, allowed_binaries)
    if refusal:
        return ToolResult.failure("run_command", "denied", refusal, command=raw)

    if workspace.dry_run:
        return ToolResult.success(
            "run_command", f"[dry-run] se ejecutaria: {' '.join(argv)}",
            command=raw, dry_run=True,
        )

    resolved = shutil.which(argv[0])
    if not resolved:
        return ToolResult.failure("run_command", "not_found", f"'{argv[0]}' no esta instalado o no esta en PATH")
    argv[0] = resolved

    timeout = max(1, min(int(timeout_s), 600))
    start = time.perf_counter()
    try:
        completed = subprocess.run(
            argv,
            cwd=str(workspace.root),
            env=_scrubbed_env(),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            shell=False,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return ToolResult.failure(
            "run_command", "timeout", f"'{raw}' ha superado {timeout}s y se ha cancelado", command=raw
        )
    except OSError as exc:
        return ToolResult.failure("run_command", "internal", f"{type(exc).__name__}: {exc}", command=raw)

    duration_ms = int((time.perf_counter() - start) * 1000)
    # stderr is always included: for a failing build it *is* the answer, and the
    # model cannot ask for it separately.
    stderr = (completed.stderr or "").strip()
    merged = (completed.stdout or "").strip()
    if stderr:
        merged = f"{merged}\n{stderr}".strip()
    body = _truncate(_redact(merged)) or "(sin salida)"
    ok = completed.returncode == 0
    return ToolResult(
        ok=ok,
        tool="run_command",
        observation=f"exit={completed.returncode}\n{body}",
        data={"command": raw, "returncode": completed.returncode, "duration_ms": duration_ms},
        error_code=None if ok else "internal",
        duration_ms=duration_ms,
    )
