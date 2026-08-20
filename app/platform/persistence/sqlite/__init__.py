"""Persistencia SQLite/JSON: la que Karajan usa en standalone y como add-on.

Los almacenes (`TaskStore`, `ResourceStore`, `RoutingLayoutStore`) ya cumplen
los Protocols de `app.core.contracts` tal cual están escritos —por eso aquí no
hay clases envoltorio que no harían nada más que reenviar llamadas— y ya
aceptan su ruta por constructor, así que lo único que faltaba era **un sitio
donde se decida esa ruta**. Eso es lo que aporta este módulo: un `data_dir`
explícito en vez de rutas relativas resueltas contra el directorio de trabajo
del proceso.

`SqliteConfigRepository` sí es código nuevo, porque la configuración activa hoy
no es un almacén sino un global reasignable de `app/main.py` (`active_config`),
que ningún módulo externo puede compartir.
"""

from __future__ import annotations

from pathlib import Path

from app import config as config_module
from app import resource_library, routing_layout
from app.database import TaskStore
from app.models import KarajanConfig

# Rutas históricas, relativas al directorio de trabajo. Se mantienen como
# valores por defecto para no cambiar dónde escribe una instalación existente.
DEFAULT_DATA_DIR = Path("data")


def build_task_repository(data_dir: Path | str = DEFAULT_DATA_DIR) -> TaskStore:
    return TaskStore(Path(data_dir) / "task_logs.db")


def build_routing_repository(data_dir: Path | str = DEFAULT_DATA_DIR) -> routing_layout.RoutingLayoutStore:
    return routing_layout.RoutingLayoutStore(Path(data_dir) / "routing_layout.json")


def build_resource_repository(data_dir: Path | str = DEFAULT_DATA_DIR) -> resource_library.ResourceStore:
    """Catálogo de Inspiration, ya sembrado y migrado.

    La siembra y la migración de perfiles del radar se hacían al importar
    `app/main.py`; pertenecen a la construcción del almacén, no al arranque de
    la API.
    """
    store = resource_library.ResourceStore(Path(data_dir) / "resources.db")
    resource_library.seed_resource_library(store)
    store.migrate_radar_profiles()
    return store


class SqliteConfigRepository:
    """Configuración activa respaldada por `data/active_config.json`.

    Guarda la configuración en memoria porque es lo que hace hoy `main.py`
    (leer el fichero en cada petición cambiaría el comportamiento y el coste),
    pero la expone tras un objeto compartido para que reemplazarla se vea desde
    todos los módulos, que es justo lo que un global reasignable no permite.
    """

    def __init__(self, data_dir: Path | str = DEFAULT_DATA_DIR) -> None:
        self._runtime_path = Path(data_dir) / "active_config.json"
        self._config = self._read()

    def _read(self) -> KarajanConfig:
        """Igual que `config.load_config()`, pero atado a este `data_dir`.

        `load_config()` sin argumentos busca el override de runtime en
        `data/active_config.json` **relativo al directorio de trabajo**; con un
        `data_dir` explícito hay que preguntarle por esa ruta o se leería la
        configuración de otra instalación.
        """
        saved = config_module.load_runtime_config(self._runtime_path)
        return saved if saved is not None else config_module.load_config()

    def load(self) -> KarajanConfig:
        return self._config

    def save(self, config: KarajanConfig) -> KarajanConfig:
        self._config = config
        config_module.save_runtime_config(config, self._runtime_path)
        return self._config

    def reload(self) -> KarajanConfig:
        """Releer desde disco (lo usa `POST /setup/apply-default` tras resetear)."""
        self._config = self._read()
        return self._config
