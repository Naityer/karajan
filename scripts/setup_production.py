"""Provision KARAJAN for production on a new machine.

Reproduces the reference hierarchy from the Decision view:
  - Claude (Anthropic)  -> Agent / parent, level N5 (critical)
  - ChatGPT (OpenAI)    -> Backup + direct delegate for N4 (medium-complex tasks)
  - Qwen + DeepSeek     -> local models via Ollama, covering N1-N3 (low tasks)

Usage:
  python scripts/setup_production.py                 # check + pull local models, report status
  python scripts/setup_production.py --check-only     # report only, no downloads or file changes
  python scripts/setup_production.py --reset-config   # also restore data/active_config.json and
                                                        # data/routing_layout.json from
                                                        # data/production_baseline/ (backs up existing
                                                        # files first)
  python scripts/setup_production.py --start          # after setup, launch the API on 127.0.0.1:8001
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

from app import catalog  # noqa: E402
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
    args = parser.parse_args()

    print("KARAJAN - puesta en producción")
    print("================================")

    print("\n[1/3] Jerarquía de routing (Claude / ChatGPT / Qwen+DeepSeek local)")
    if args.reset_config:
        reset_config()
    else:
        print("  Usando data/active_config.json y data/routing_layout.json actuales.")
        print("  (usa --reset-config para forzar la jerarquía de referencia)")

    print("\n[2/3] Modelos locales (Ollama) para tareas N1-N3")
    ollama_ok = setup_ollama(args.check_only)

    print("\n[3/3] Credenciales de API (Claude = agente N5, ChatGPT = backup/N4)")
    api_ok = True
    for name in REQUIRED_API_PROVIDERS:
        status = check_api_key(name)
        print(f"  [{'OK' if status.ready else 'FALTA'}] {name}: {status.detail}")
        api_ok = api_ok and status.ready

    print("\n================================")
    all_ready = ollama_ok and api_ok
    if all_ready:
        print("Listo para producción: Claude -> ChatGPT (backup/N4) -> Qwen+DeepSeek local (N1-N3) operativo.")
    else:
        print("Configuración incompleta. Resuelve los puntos marcados como FALTA/ERROR antes de delegar tareas reales.")

    if args.start:
        start_server()
        return 0

    return 0 if all_ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
