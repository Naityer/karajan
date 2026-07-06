"""Provision KARAJAN for production on a new machine.

Reproduces the reference hierarchy from the Decision view:
  - Claude (Anthropic)  -> Agent / parent, level N5 (critical)
  - ChatGPT (OpenAI)    -> Backup + direct delegate for N4 (medium-complex tasks)
  - Qwen + DeepSeek     -> local models via Ollama, covering N1-N3 (low tasks)

Usage:
  python scripts/setup_production.py                 # interactive (in a TTY): asks about
                                                        # hierarchy reset, skills, OpenClaw
  python scripts/setup_production.py --check-only     # report only, no downloads or file changes
  python scripts/setup_production.py --reset-config   # also restore data/active_config.json and
                                                        # data/routing_layout.json from
                                                        # data/production_baseline/ (backs up existing
                                                        # files first)
  python scripts/setup_production.py --start           # after setup, launch the API on 127.0.0.1:8001
  python scripts/setup_production.py --non-interactive # never prompt, even in a TTY (for CI)
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from app.env import ensure_project_env, load_project_env  # noqa: E402

ensure_project_env()
load_project_env()

from app import catalog, setup_status, skills_catalog  # noqa: E402
from app.config import load_config  # noqa: E402
from app.openclaw_client import OpenClawClient  # noqa: E402
from app.production_setup import (  # noqa: E402
    BASELINE_DIR,
    ACTIVE_CONFIG_PATH,
    ROUTING_LAYOUT_PATH,
    REQUIRED_API_PROVIDERS,
    ollama_required_models,
    ollama_installed_models,
    check_api_key,
    reset_config as _reset_config,
)

OLLAMA_PULL_TIMEOUT_S = 60 * 30  # local model weights can be several GB


def ask_yes_no(question: str, default: bool = False) -> bool:
    """Prompt a yes/no question; EOF (piped stdin) or a blank answer uses `default`."""
    suffix = "[S/n]" if default else "[s/N]"
    try:
        raw = input(f"{question} {suffix} ").strip().lower()
    except EOFError:
        return default
    if not raw:
        return default
    return raw in {"s", "si", "sí", "y", "yes"}


def _parse_index_selection(raw: str, options: list[str]) -> list[str]:
    """Parse a comma-separated "1,3" style selection against a numbered option list.

    Out-of-range and non-numeric chunks are silently ignored rather than raising —
    this drives an interactive prompt, not a strict API, so a typo shouldn't crash it.
    """
    selected: list[str] = []
    for chunk in raw.split(","):
        chunk = chunk.strip()
        if not chunk.isdigit():
            continue
        index = int(chunk) - 1
        if 0 <= index < len(options):
            selected.append(options[index])
    return selected


def pull_model(model: str) -> bool:
    print(f"\n==> ollama pull {model}")
    try:
        completed = subprocess.run(["ollama", "pull", model], timeout=OLLAMA_PULL_TIMEOUT_S, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        print(f"    fallo al ejecutar ollama pull: {exc}")
        return False
    return completed.returncode == 0


def reset_config() -> None:
    if not BASELINE_DIR.exists():
        print("  No se encontró data/production_baseline/; no se puede restaurar la jerarquía de referencia.")
        return
    backups = _reset_config()
    for backup in backups:
        print(f"  copia de seguridad: {backup}")
    print(f"  restaurado: {ACTIVE_CONFIG_PATH}")
    print(f"  restaurado: {ROUTING_LAYOUT_PATH}")


def prompt_reset_hierarchy() -> None:
    print("  ¿Restaurar la jerarquía de referencia (Claude / ChatGPT / Qwen+DeepSeek local)?")
    print("  Esto sobrescribe data/active_config.json y data/routing_layout.json (con copia de seguridad).")
    if ask_yes_no("  ¿Restaurar ahora?", default=False):
        reset_config()
    else:
        print("  Usando la jerarquía actual sin cambios.")


def prompt_skills() -> None:
    pending = [skill for skill in skills_catalog.list_skills() if not skill.installed]
    if not pending:
        print("  Todas las skills del catálogo ya están instaladas.")
        return
    print("  Skills disponibles para instalar:")
    for index, skill in enumerate(pending, start=1):
        print(f"    {index}. {skill.name} — {skill.description}")
    try:
        raw = input("  Números a instalar, separados por coma (Enter para omitir): ").strip()
    except EOFError:
        raw = ""
    if not raw:
        print("  Omitido.")
        return
    for name in _parse_index_selection(raw, [skill.name for skill in pending]):
        result = skills_catalog.install_skill(name)
        print(f"    [{'OK' if result.ok else 'ERROR'}] {name}: {result.detail}")


def prompt_openclaw() -> None:
    if not ask_yes_no("  ¿Configurar OpenClaw ahora (canales, plugins, gateway)?", default=False):
        print("  Omitido; puedes configurarlo luego desde la pestaña Decisión.")
        return
    client = OpenClawClient(load_config())
    for command in client.setup_commands():
        print(f"\n    [{command.section}] {command.description}")
        print(f"      {command.command}")
    print("\n  Ejecuta los comandos anteriores manualmente en tu terminal cuando quieras.")


def setup_ollama(check_only: bool) -> bool:
    required = ollama_required_models()
    binary = shutil.which("ollama")
    if not binary:
        provider = catalog.get_provider("ollama")
        print("  Ollama no está instalado.")
        print(f"  Instálalo desde: {provider.signup_url if provider else 'https://ollama.com/download'}")
        return False

    installed = ollama_installed_models()
    ok = True
    for model in required:
        if model in installed:
            print(f"  [OK] {model} ya está descargado.")
            continue
        if check_only:
            print(f"  [FALTA] {model} (ejecuta sin --check-only para descargarlo)")
            ok = False
            continue
        if pull_model(model):
            print(f"  [OK] {model} descargado correctamente.")
        else:
            print(f"  [ERROR] no se pudo descargar {model}.")
            ok = False
    return ok


def start_server() -> None:
    print("\nArrancando KARAJAN en http://127.0.0.1:8001 ...")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8001"],
        cwd=str(PROJECT_ROOT),
    )
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check-only", action="store_true", help="Solo reporta el estado, sin descargar modelos ni tocar archivos.")
    parser.add_argument(
        "--reset-config",
        action="store_true",
        help="Restaura data/active_config.json y data/routing_layout.json desde data/production_baseline/ (con copia de seguridad).",
    )
    parser.add_argument("--start", action="store_true", help="Tras la verificación, arranca la API en 127.0.0.1:8001.")
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Nunca preguntar de forma interactiva, incluso en una terminal (para CI/scripts).",
    )
    args = parser.parse_args()

    explicit_flags = args.check_only or args.reset_config or args.start
    interactive = sys.stdin.isatty() and not explicit_flags and not args.non_interactive

    print("KARAJAN - puesta en producción")
    print("================================")

    print("\n[1/5] Jerarquía de routing (Claude / ChatGPT / Qwen+DeepSeek local)")
    if args.reset_config:
        reset_config()
    elif interactive:
        prompt_reset_hierarchy()
    else:
        print("  Usando data/active_config.json y data/routing_layout.json actuales.")
        print("  (usa --reset-config para forzar la jerarquía de referencia)")

    print("\n[2/5] Modelos locales (Ollama) para tareas N1-N3")
    ollama_ok = setup_ollama(args.check_only)

    print("\n[3/5] Credenciales de API (Claude = agente N5, ChatGPT = backup/N4)")
    api_ok = True
    for name in REQUIRED_API_PROVIDERS:
        status = check_api_key(name)
        print(f"  [{'OK' if status.ready else 'FALTA'}] {name}: {status.detail}")
        api_ok = api_ok and status.ready

    print("\n[4/5] Skills")
    if interactive:
        prompt_skills()
    else:
        print("  Omitido (modo no interactivo). Instálalas luego desde la pestaña Configuración.")

    print("\n[5/5] OpenClaw (integración opcional)")
    if interactive:
        prompt_openclaw()
    else:
        print("  Omitido (modo no interactivo). Configúralo luego desde la pestaña Decisión.")

    print("\n================================")
    all_ready = ollama_ok and api_ok
    if all_ready:
        print("Listo para producción: Claude -> ChatGPT (backup/N4) -> Qwen+DeepSeek local (N1-N3) operativo.")
    else:
        print("Configuración incompleta. Resuelve los puntos marcados como FALTA/ERROR antes de delegar tareas reales.")

    if not args.check_only:
        setup_status.mark_complete()

    if args.start:
        start_server()
        return 0

    return 0 if all_ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
