# Especialistas y skills sueltas

Los especialistas categorizan una tarea y aportan un modelo y un paquete acotado de skills. El selector sigue recomendando skills independientes; la composición conserva todas las aportaciones y elimina duplicados sin perder su procedencia.

El catálogo inicial contiene 40 definiciones. El análisis de la instantánea local encuentra cobertura completa para 33; los otros siete paquetes no se seleccionan hasta que sus instrucciones estén disponibles. Véanse [análisis](especialistas-analisis.md) e [inventario completo](especialistas-inventario.json). Cobertura de instrucciones no demuestra que estén instaladas todas las herramientas o conectadas las cuentas que requiere cada skill.

## Uso

En Atlas dev, la propiedad **Especialidad** de una tarea admite Auto, Ninguna o un especialista con cobertura. El modelo escrito por la persona y el proveedor resuelto conservan prioridad. Las skills manuales se mantienen y el paquete puede incorporar sugerencias adicionales.

En proyectos, cada tarea segmentada se planifica por separado. La tabla del plan muestra su especialidad y el conjunto de skills. Al aceptar el plan se conservan en la hoja la especialización y la base recuperable. La cola vuelve a comprobar y preparar el paquete en el equipo que efectivamente ejecuta la tarea. Si el componente desaparece entre la planificación y el lanzamiento, se recupera el modelo y las skills de base; no se dejan como requisitos obligatorios las skills opcionales del paquete.

La cabecera del Monitor muestra la especialidad aplicada. El evento `especialista` conserva modelo, paquete, skills de base y skills efectivas. Preparación y uso confirmado siguen siendo conceptos diferentes: esta integración no fabrica evidencia de uso a partir de la mera instalación.

```text
kj control especialistas
kj control mision "Analiza las relaciones del código" --especialista grafos --json
kj control mision "Analiza las relaciones del código" --especialista grafos --ejecutar
kj especialistas describe
kj especialistas config
```

`control mision` no ejecuta sin `--ejecutar`. La delegación real conserva el control de revisión humana, disponibilidad y límites de los proveedores. El especialista no cambia el proveedor escogido por esas políticas. Una entidad forzada no recibe especialización automática; puede combinarse con un especialista explícito.

## API del paquete

- `GET /especialistas`: catálogo, paquete, modelos, cobertura y skills que faltan. No exige `resources.db`.
- `GET /especialistas/config`: configuración vigente.
- `PUT /especialistas/config`: reemplazo validado, protegido por el guardián existente y una tarea aceptada en producción.
- `POST /routing/plan` y `POST /delegate-task`: admiten `especialista: "id"` o `"ninguno"`, además de los campos anteriores.
- `POST /especialistas/resolver`: entrada `{prompt, proveedor, skills?, especialista?, preparar?, tarea?}`. Mantiene el proveedor recibido y devuelve el especialista, skills compuestas y procedencias. `preparar: true` utiliza el rotador y exige autorización del guardián. Es el contrato que usa la cola en proceso; sin ese campo solo consulta.

El puente de Atlas dev expone `GET /karajan/especialistas` y transmite la opción a `/karajan/plan` y `/karajan/delegar`. La configuración puede administrarse por las rutas del paquete y `kj especialistas config --set '<objeto completo>' --tarea <id>`.

Ejemplo de definición en `<datos efectivos>/especialistas.json`:

```json
{
  "activo": true,
  "automatico": true,
  "agentes": [{
    "id": "grafos",
    "nombre": "Grafos y redes",
    "ambito": "Extraer relaciones y analizar grafos.",
    "skills": ["graphify", "networkx"],
    "terminos": ["grafos", "grafo", "graphml"],
    "modelos": {"codex": "default", "claude-cli": "sonnet"},
    "activo": true
  }]
}
```

Son valores iniciales compatibles con los ejecutores existentes, no un ranking de modelos. Codex `default` conserva el modelo de la cuenta; un nombre concreto se transmite mediante `--model`. Configurar un modelo no acredita acceso a él. El modelo que fijó la persona conserva prioridad en la cola.

## Selección, fallos y coste

Se exige un mínimo de dos skills distintas y la presencia de todo el paquete en instalaciones o almacén local. Se comparan términos completos, normalizados por mayúsculas y acentos. Las coincidencias empatadas y las tareas sin coincidencia suficiente conservan el flujo base. La invocación explícita permite elegir una especialidad aunque el prompt no incluya sus términos; no omite la cobertura ni el estado habilitado.

Una configuración ausente utiliza los valores de fábrica. Al guardar se valida antes de escribir, se reemplaza atómicamente y se conserva `.bak`. Una configuración ilegible utiliza el respaldo; sin respaldo válido desactiva el componente. No se sobrescribe el archivo roto al leer.

Si no encaja, está desactivado, falla o no puede preparar su paquete, se conserva la asignación y las sugerencias originales. Un fallo de skill originalmente requerida sigue siendo un fallo original: el respaldo no elimina esas validaciones. En delegación queda registrada la elección planificada y, por separado, la especialidad efectivamente ejecutada o su degradación.

El inventario se reutiliza durante 15 segundos y se invalida al guardar configuración o preparar un paquete. La planificación recorre 40 definiciones pequeñas; no lee el inventario JSON documental, no consulta toda Biblioteca, no introduce llamadas LLM ni hace peticiones de red para seleccionar. Los paquetes no cargan todos sus cuerpos en el prompt; el agente recibe los nombres y consulta SKILL.md cuando corresponde.

Esta versión implementa especialistas en el paquete TypeScript y en Atlas dev. El servidor Python independiente conserva su comportamiento anterior; no se presenta como una implementación con paridad. No se instala ni activa el paquete sobre la aplicación en producción como parte de esta tarea.
