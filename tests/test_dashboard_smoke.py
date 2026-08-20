"""Red de seguridad del dashboard antes de trocearlo.

`dashboard/static/app.js` son 11.765 líneas de JS sin una sola prueba: la
modularización (nota "Plan de mejora", §18) las reparte en seis módulos, y sin
algo que abra la interfaz de verdad una regresión solo se descubre usándola.

Esto arranca el servidor real en un directorio de datos temporal —nunca el
`data/` del usuario— abre el dashboard en Chromium y recorre las seis vistas
comprobando dos cosas por vista: que la sección correspondiente queda activa y
que el navegador no ha soltado ni un error de consola. Además guarda una
captura por vista en `tests/artifacts/dashboard/`, que es la referencia visual
contra la que comparar después de partir `styles.css` (12.563 líneas de capas
de parches cuyo orden es semántico).

Se salta solo si Playwright o su Chromium no están instalados, para no romper
la suite de quien no los tenga:

    .venv/Scripts/python -m pip install playwright && playwright install chromium
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

import pytest

pytest.importorskip("playwright.sync_api", reason="Playwright no está instalado")

from playwright.sync_api import Error as PlaywrightError  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = Path(__file__).parent / "artifacts" / "dashboard"

# `data-view` del `index.html` → id de la sección que debe quedar activa.
VIEWS = [
    ("human", "view-human"),
    ("monitor", "view-monitor"),
    ("decision", "view-decision"),
    ("agents", "view-agents"),
    ("resources", "view-resources"),
    ("flow", "view-flow"),
]

# Ruido esperado que no indica una regresión del dashboard: el navegador se
# queja de peticiones que fallan por no haber proveedores/red en el entorno de
# pruebas, no por el código de la vista.
IGNORED_CONSOLE = (
    "Failed to load resource",
    "net::ERR_",
    "favicon",
)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture(scope="module")
def dashboard_server(tmp_path_factory: pytest.TempPathFactory):
    """Uvicorn real en un `cwd` temporal.

    Los stores de `app/main.py` se crean al importar y resuelven rutas
    relativas (`data/task_logs.db`, `data/resources.db`,
    `data/routing_layout.json`), así que aislar los datos es exactamente
    aislar el directorio de trabajo del proceso. `STATIC_DIR` es absoluto y
    sigue sirviendo el dashboard real.
    """
    workdir = tmp_path_factory.mktemp("karajan-smoke")
    (workdir / "data").mkdir()
    port = _free_port()

    env = {
        **os.environ,
        "PYTHONPATH": str(REPO_ROOT),
        "KARAJAN_REQUIRE_ATLAS_TOKEN": "0",
        "PYTHONIOENCODING": "utf-8",
    }
    env.pop("KARAJAN_TOKEN", None)

    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=workdir,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    base_url = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            if process.poll() is not None:
                output = (process.stdout.read() or b"").decode("utf-8", "replace")
                pytest.fail(f"el servidor murió al arrancar:\n{output}")
            try:
                with urlopen(f"{base_url}/health", timeout=1):
                    break
            except (URLError, OSError):
                time.sleep(0.4)
        else:
            pytest.fail("el servidor no respondió a /health en 60s")
        yield base_url
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()


@pytest.fixture(scope="module")
def browser():
    with sync_playwright() as playwright:
        try:
            instance = playwright.chromium.launch()
        except PlaywrightError as exc:  # navegador no instalado
            pytest.skip(f"Chromium de Playwright no disponible: {exc}")
        try:
            yield instance
        finally:
            instance.close()


def _relevant(message: str) -> bool:
    return not any(noise in message for noise in IGNORED_CONSOLE)


def test_every_view_mounts_without_console_errors(dashboard_server: str, browser) -> None:
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    errors: list[str] = []
    page.on("console", lambda msg: errors.append(f"console.{msg.type}: {msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))

    page.goto(dashboard_server, wait_until="domcontentloaded")
    page.wait_for_selector("#viewNav .view-tab", timeout=30_000)

    for view, section_id in VIEWS:
        page.click(f'.view-tab[data-view="{view}"]')
        page.wait_for_selector(f"#{section_id}.active", timeout=15_000)
        page.wait_for_timeout(1200)  # deja terminar el render y las peticiones de la vista
        page.screenshot(path=str(ARTIFACTS / f"{view}.png"), full_page=False)

    page.close()

    relevant = [error for error in errors if _relevant(error)]
    assert not relevant, "errores de JS al recorrer las vistas:\n" + "\n".join(relevant)
