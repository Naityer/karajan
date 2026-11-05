"""Limpia lo que se regenera (cachés y artefactos de compilación) sin tocar código, datos ni entornos.

    python scripts/limpiar.py            # lista lo que borraría (no borra nada)
    python scripts/limpiar.py --aplicar  # lo borra

Borra solo: `__pycache__`, `.pytest_cache`, `.ruff_cache`, `karajan.egg-info`, `dist-atlas` y `.tmp*`. Nunca toca `.venv`,
`.env`, `data/`, `.trabajo/` (worktrees) ni `.ua/`.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
NOMBRES = {"__pycache__", ".pytest_cache", ".ruff_cache", "karajan.egg-info", "dist-atlas"}
PROTEGIDOS = {".venv", ".git", ".trabajo", ".ua", "node_modules", "data"}


def candidatos() -> list[Path]:
    salida: list[Path] = []
    pendientes = [RAIZ]
    while pendientes:
        carpeta = pendientes.pop()
        for hijo in carpeta.iterdir():
            if not hijo.is_dir() or hijo.name in PROTEGIDOS:
                continue
            if hijo.name in NOMBRES or (carpeta == RAIZ and hijo.name.startswith(".tmp")):
                salida.append(hijo)
            else:
                pendientes.append(hijo)
    return sorted(salida)


def peso(ruta: Path) -> int:
    return sum(f.stat().st_size for f in ruta.rglob("*") if f.is_file())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--aplicar", action="store_true", help="borrar de verdad (por defecto solo lista)")
    args = ap.parse_args()
    cs = candidatos()
    total = 0
    for c in cs:
        total += (n := peso(c))
        print(f"{'borrado ' if args.aplicar else 'borraría'} {c.relative_to(RAIZ)}  ({n / 1024:.0f} KB)")
        if args.aplicar:
            shutil.rmtree(c, ignore_errors=True)
    print(f"{len(cs)} carpetas, {total / 1024 / 1024:.1f} MB" + ("" if args.aplicar else "  (usa --aplicar para borrar)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
