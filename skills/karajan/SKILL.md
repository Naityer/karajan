---
name: karajan
description: Clasifica y registra tareas de desarrollo en el router local KARAJAN; delega solo cuando el usuario lo solicita.
---

# KARAJAN — router local de tareas

Utiliza el servidor MCP de Karajan cuando esté disponible. `karajan_health` comprueba el servicio y `karajan_classify` clasifica y registra la tarea sin ejecutarla. Lee la clasificación y continúa localmente cuando corresponda. No fabriques clasificaciones ni registros `/ingest`.

Si el MCP no está disponible, el servidor HTTP se arranca desde el repositorio con `python -m uvicorn app.main:app --host 127.0.0.1 --port 8001`; la API `POST /classify-task` recibe `prompt` y, opcionalmente, `entry_agent`. La terminal de Atlas dev usa `kj`; consulta `docs/CLI.md` para sus comandos y su conexión.

Solo usa `karajan_assign` o `karajan_run` cuando el usuario solicite ejecución por otro agente o proveedor. Respeta la revisión humana y las autorizaciones necesarias para acciones externas.
