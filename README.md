# KARAJAN

Router de tareas para agentes de IA, pensado como un **servicio que corre en un servidor y se maneja por terminal**. Clasifica una tarea, recomienda agente y skills, delega, guarda la traza auditable y ofrece analítica, todo con salida en texto (ASCII) o `--json`.

Karajan se organiza como un «JDK»: cada **componente** (clasificador, delegador, dosificador, selector, rotador, proveedores, biblioteca, laboratorio…) es una librería con su configuración, su laboratorio de pruebas y sus comandos. Los **módulos** (Estadísticas, Inspiration, Control) los combinan para mostrar datos.

## Puesta en marcha

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\uvicorn app.main:app --host 127.0.0.1 --port 8001
```

La CLI `kj` y el paquete de Atlas dev se construyen con `node atlas/build.mjs` y se usan con `node dist-atlas/kj.mjs` (ver [docs/CLI.md](docs/CLI.md)). Para desarrollo: `pip install -r requirements-dev.txt` y `node atlas/ejecutar-tests.mjs`.

## Estructura

| Ruta | Contenido |
|---|---|
| `app/` | Servidor Python (FastAPI) por capas: `domain/` (modelos), `persistence/`, `routing/`, `execution/`, `resources/`, `providers/`, `configuration/`, `security/`, `application/` y `modules/*/api.py` |
| `atlas/` | Núcleo en TypeScript: componentes, laboratorios, SDK de comandos (`src/sdk/`) y la CLI `kj` (paquete de Atlas dev) |
| `karajan_cli/` | CLI Python `karajan` (en migración hacia `kj`) y el servidor MCP (`python -m karajan_cli.mcp_server`) |
| `dashboard/` | Interfaz web congelada; se adaptará a los datos de los comandos |
| `deploy/` | Dockerfile y `docker-compose.yml` (contexto: la raíz del repo) |
| `scripts/` | Operación: instalación, producción, auditorías y `limpiar.py` |
| `skills/` | Skills de Karajan para agentes (`karajan`, `task-router`) |
| `assets/` | Imágenes de marca |
| `data/` | Estado de ejecución (no versionado) y `production_baseline/` |
| `tests/` | Pruebas Python por paquete (las de TypeScript están en `atlas/tests/`) |
| `docs/` | Documentación, con índice en [docs/README.md](docs/README.md) |

## Documentación

- [docs/README.md](docs/README.md): índice.
- [docs/CLI.md](docs/CLI.md): comandos.
- [docs/laboratorio/componentes.md](docs/laboratorio/componentes.md): componentes y laboratorios.
- [docs/referencia-api.md](docs/referencia-api.md): API HTTP, autenticación y configuración.
- Contenedor: `docker compose -f deploy/docker-compose.yml up -d --build`. Limpieza de cachés: `python scripts/limpiar.py`.
