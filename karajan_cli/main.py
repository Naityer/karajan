"""Small compatibility adapter for the historical ``karajan`` entry point.

The former interactive CLI is not recreated here.  These commands reuse the
same embedded/HTTP client as MCP; unsupported legacy commands fail explicitly.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from fastapi.encoders import jsonable_encoder
from karajan_cli.client import KarajanApiError, build_client


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="karajan", description="Adaptador de compatibilidad; para la terminal completa usa kj.")
    parser.add_argument("--json", action="store_true", help="Salida JSON")
    parser.add_argument("--transport", choices=("embedded", "http"), default=os.environ.get("KARAJAN_TRANSPORT"))
    parser.add_argument("--url", default=os.environ.get("KARAJAN_URL"))
    parser.add_argument("--data-dir", default=os.environ.get("KARAJAN_DATA_DIR"))
    parser.add_argument("--token", default=os.environ.get("KARAJAN_TOKEN"))
    commands = parser.add_subparsers(dest="command", required=True)
    activate = commands.add_parser("activate", help="Comprueba el transporte configurado")
    activate.add_argument("--start", action="store_true", help="Comprueba el motor embebido; no inicia un servidor HTTP")
    classify = commands.add_parser("classify", help="Clasifica y registra una tarea")
    classify.add_argument("--entry", default=os.environ.get("KARAJAN_ENTRY_AGENT"))
    classify.add_argument("prompt")
    assign = commands.add_parser("assign", help="Delega una tarea a un proveedor o entidad")
    assign.add_argument("task_id", nargs="?")
    assign.add_argument("--prompt")
    assign.add_argument("--to", required=True)
    assign.add_argument("--entity", action="store_true")
    return parser


def _data_dir(configured: str | None) -> str:
    # Do not initialise an alternative empty installation just because a CLI
    # is invoked from a different directory.
    if configured:
        path = Path(configured).expanduser().resolve()
    else:
        from karajan_cli.userconfig import get_repo_root

        root = get_repo_root() or Path(__file__).resolve().parents[1]
        path = root / "data"
    if not path.is_dir() or not (path / "task_logs.db").is_file():
        raise ValueError(f"No hay una instalación Karajan existente en {path}. Indica --data-dir o KARAJAN_DATA_DIR con su task_logs.db.")
    return str(path)


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    transport = args.transport or ("http" if args.url else "embedded")
    if transport == "embedded" and args.url:
        parser.error("--url/KARAJAN_URL no es compatible con --transport embedded")
    if args.command == "assign" and bool(args.task_id) == bool(args.prompt):
        parser.error("assign requiere exactamente uno de task_id o --prompt")
    client = None
    try:
        data_dir = _data_dir(args.data_dir) if transport == "embedded" else "data"
        client = build_client(transport=transport, url=args.url, token=args.token, data_dir=data_dir)
        if args.command == "activate":
            if args.start and transport == "http" and not client.is_running():
                raise ValueError("El adaptador no inicia servidores HTTP. Arranca uvicorn o selecciona el transporte embebido.")
            if not client.is_running():
                raise ValueError("El servidor Karajan HTTP no está disponible.")
            result = client.health()
            if not args.json:
                print(f"Karajan disponible ({transport}): {result.get('status', 'desconocido')}. "
                      + ("El motor embebido se cierra al terminar el comando." if transport == "embedded" else ""))
                return 0
        elif args.command == "classify":
            result = client.classify(args.prompt, args.entry)
        else:
            task_id = args.task_id
            if args.prompt:
                task_id = client.classify(args.prompt, os.environ.get("KARAJAN_ENTRY_AGENT") or None)["task_id"]
            result = client.delegate(task_id, force_entity_id=args.to if args.entity else None,
                                     force_provider=None if args.entity else args.to)
        print(json.dumps(jsonable_encoder(result), ensure_ascii=False, indent=2))
        return 0
    except (KarajanApiError, ValueError, OSError, RuntimeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    finally:
        close = getattr(client, "close", None)
        if close is not None:
            close()


def run() -> None:
    raise SystemExit(main())


if __name__ == "__main__":
    run()
