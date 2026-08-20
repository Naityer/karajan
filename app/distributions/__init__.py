"""Los tres modos de ejecución de Karajan (nota "Plan de mejora", §4-§5, §14).

Standalone, add-on de Atlas y SaaS no son tres aplicaciones — son tres formas
de construir el mismo `KarajanRuntime` (`app/runtime.py`) y pasárselo a la
misma factoría de API (`app/api/factory.py::create_app`). Cada módulo de aquí
es la configuración concreta de un modo, no una reimplementación.
"""

from app.distributions.atlas import create_atlas_addon_app
from app.distributions.saas import create_saas_app
from app.distributions.standalone import create_standalone_app

__all__ = ["create_standalone_app", "create_atlas_addon_app", "create_saas_app"]
