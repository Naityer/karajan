"""Punto de entrada ASGI (`uvicorn app.main:app`).

Construye la instalación standalone y la monta con la factoría
`app/api/factory.py::create_app` (la única que sabe ensamblar la API). Los nombres
`store`, `active_config`, `resource_store`... son **vistas de compatibilidad**
del runtime: los tests las sustituyen por nombre (`monkeypatch.setattr(main, ...)`)
y `karajan_mcp`/scripts las leen; los endpoints no las usan, leen
`runtime.current()` en cada petición.
"""

from __future__ import annotations

from app.api.factory import create_app
from app.application.runtime import build_standalone_runtime
from app.configuration.env import load_project_env
from app.models import KarajanConfig

load_project_env()

runtime = build_standalone_runtime()
app = create_app(runtime)

store = runtime.tasks
layout_store = runtime.routing
active_config: KarajanConfig = runtime.config
scheduler = runtime.scheduler
resource_store = runtime.resources
resource_analyzer = runtime.resource_analyzer
web_reference_analyzer = runtime.web_reference_analyzer
resource_installer = runtime.resource_installer
naityer_adapter = runtime.naityer_adapter
nested_resource_indexer = runtime.nested_resource_indexer
local_resource_analyzer = runtime.local_resource_analyzer
resource_ranking_engine = runtime.resource_ranking_engine
inspiration_feed = runtime.inspiration_feed
resource_refresh = runtime.resource_refresh
