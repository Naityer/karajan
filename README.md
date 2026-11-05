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
| `app/` | Servidor Python (FastAPI): `routing/`, `execution/`, `resources/`, `providers/`, `application/`, `modules/*/api.py` |
| `atlas/` | Núcleo en TypeScript: componentes, laboratorios y CLI `kj` (paquete de Atlas dev) |
| `karajan_cli/` | CLI Python `karajan` (en migración hacia `kj`) |
| `data/` | Estado de ejecución (no versionado) y `production_baseline/` |
| `docs/` | CLI, componentes y laboratorios, ADR y API HTTP |
| `dashboard/` | Interfaz web congelada; se adaptará a los datos de los comandos |

## Documentación

- [docs/CLI.md](docs/CLI.md): comandos.
- [docs/laboratorio/componentes.md](docs/laboratorio/componentes.md): componentes y laboratorios.
- [docs/referencia-api.md](docs/referencia-api.md): API HTTP, autenticación y configuración.
