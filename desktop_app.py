from __future__ import annotations

import socket
import sys
import threading
import time
from contextlib import closing


HOST = "127.0.0.1"
PREFERRED_PORT = 8001
APP_IMPORT = "app.main:app"


def _port_is_free(port: int) -> bool:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        return sock.connect_ex((HOST, port)) != 0


def find_free_port() -> int:
    if _port_is_free(PREFERRED_PORT):
        return PREFERRED_PORT
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
        sock.bind((HOST, 0))
        return int(sock.getsockname()[1])


def wait_until_ready(port: int, timeout_s: float = 8.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as sock:
            sock.settimeout(0.25)
            if sock.connect_ex((HOST, port)) == 0:
                return
        time.sleep(0.1)
    raise RuntimeError(f"KARAJAN backend did not start on {HOST}:{port}")


def main() -> int:
    try:
        import uvicorn
    except ImportError:
        print(
            "uvicorn is required to run the local FastAPI backend.\n"
            "Install project requirements with:\n"
            "  python -m pip install -r requirements.txt",
            file=sys.stderr,
        )
        return 1

    try:
        import webview
    except ImportError:
        print(
            "pywebview is required for desktop window mode.\n"
            "Install it with:\n"
            "  python -m pip install pywebview\n"
            "or reinstall project requirements:\n"
            "  python -m pip install -r requirements.txt",
            file=sys.stderr,
        )
        return 1

    port = find_free_port()
    config = uvicorn.Config(APP_IMPORT, host=HOST, port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="karajan-fastapi", daemon=True)
    thread.start()
    wait_until_ready(port)

    url = f"http://{HOST}:{port}"
    window = webview.create_window(
        "KARAJAN",
        url,
        width=1280,
        height=820,
        min_size=(1024, 680),
        text_select=True,
    )

    def on_closed() -> None:
        server.should_exit = True

    window.events.closed += on_closed
    webview.start(debug=False)
    server.should_exit = True
    thread.join(timeout=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
