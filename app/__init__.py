"""KARAJAN AI Harness Router."""

#: Fuente única de la versión del backend. `main.py` la pasa a `FastAPI(version=...)`;
#: el módulo Shared (`app/modules/shared/api.py`) la reporta en `/health` — antes de
#: la modularización ambos leían el mismo literal repetido en dos sitios.
KARAJAN_VERSION = "0.2.0"
