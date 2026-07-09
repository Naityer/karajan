# Biblioteca de recursos de Karajan

Contenido editorial editable a mano para la biblioteca de recursos que comparten
"Configuración tradicional" y "Prompting configuration". Edita libremente los
textos: el dashboard vuelve a leer este archivo al cargar.

Convención de formato (parser simple, sin dependencias):
- `## Seccion` abre un grupo (Roles, Niveles, Restricciones).
- `### Titulo` abre un recurso; el texto del encabezado es el título visible.
- Debajo del `###`, cero o más líneas `clave: valor` de metadatos.
- La primera línea que no sea `clave: valor` empieza la descripción (uno o varios
  párrafos hasta el siguiente `###`).

Claves de metadatos usadas:
- `key`   → mapea al identificador interno (ROLE_DEFS / LEVELS). Genera el id `role:<key>` o `level:<key>`.
- `id`    → id explícito para Restricciones (p. ej. `policy:sensitive`).
- `group` → grupo visible para Restricciones (Restricciones, Coste, Credenciales).
- `restriction` → etiqueta de restricción del rol (R0–R3).
- `example` → línea de ejemplo que se muestra como código en el detalle.

## Roles

### Agent
key: parent
restriction: R0
example: Define un Agent raíz que reciba la tarea, la clasifique y reparta subtareas a los Workers.
Único rol con autoridad de orquestación (R0). Recibe la petición, la clasifica por complejidad, planifica el trabajo, enruta cada parte al nodo adecuado y delega. No ejecuta trabajo de dominio por sí mismo: decide quién lo hace, con qué modelo y bajo qué reglas. Es el punto de entrada de la jerarquía y el que aplica las puertas de revisión humana.

### Worker
key: child
restriction: R1
example: Asigna un Worker por cada nivel de complejidad para que ejecute sin solaparse con otros.
Ejecutor de primera línea (R1). Recibe subtareas concretas del Agent y las resuelve con el modelo asignado a su nivel de complejidad. Puede ser propietario de uno o varios niveles, pero cada nivel debe tener un único Worker responsable para evitar solapes y trabajo duplicado. Es el caballo de batalla de la ejecución real.

### Backup
key: backup
restriction: R1
example: Mantén un Backup en standby que asuma el rol de Agent si el principal cae.
Reserva en caliente (R1) con las mismas capacidades de ejecución que un Worker. Permanece en standby y puede asumir el rol de Agent si el nodo principal falla, se satura o supera su timeout. Aporta continuidad ante caídas sin duplicar coste mientras no se activa. Úsalo cuando la tarea no puede quedarse sin orquestador.

### Guardian
key: guardian
restriction: R2
example: Añade un Guardian que supervise a un Worker crítico y frene salidas dudosas.
Rol de soporte (R2) que acompaña o revisa a un Worker concreto. No es propietario de niveles de complejidad: su trabajo es vigilar la calidad y coherencia de otro nodo, señalar desviaciones y frenar salidas dudosas antes de que avancen. Útil en tareas sensibles donde conviene un segundo par de ojos sobre un ejecutor específico.

### Validator
key: validator
restriction: R2
example: Coloca un Validator al final del flujo para comprobar la salida antes de entregarla.
Rol de soporte (R2) especializado en verificar salidas parciales o finales de otros nodos. No ejecuta la tarea ni posee niveles: comprueba que el resultado cumple los criterios (tests, contratos, evidencias) y da el visto bueno o devuelve el trabajo. Es la última comprobación de calidad antes de cerrar una tarea.

### Fixeador
key: fixer
restriction: R2
example: Etiqueta un agente como Fixeador para que Grafo le delegue "Solucionar todos" con el reporte completo de hallazgos.
Rol de soporte (R2) orientado a intervención sobre código desde el panel de Grafo. Cuando el panel de Hallazgos detecta problemas y se pulsa "Solucionar todos", Karajan debe enviar al agente con etiqueta Fixeador el reporte completo de errores para que intente aplicar parches acotados. Después se vuelve a ejecutar la auditoría/test del Grafo para comprobar qué hallazgos quedaron resueltos y cuáles siguen pendientes. No es un Validator: el Validator acepta o rechaza una salida; el Fixeador corrige código a partir de fallos concretos.

### Memory
key: memory
restriction: R3
example: Usa un nodo Memory para conservar checkpoints y contexto entre iteraciones largas.
Rol de estado (R3) que mantiene contexto, checkpoints y memoria de trabajo entre pasos e iteraciones. No ejecuta ni valida: conserva el estado necesario para que la jerarquía no pierda el hilo en tareas largas o reanudables. Imprescindible cuando el flujo supera una sola pasada o debe poder retomarse.

### Monitor
key: monitor
restriction: R3
example: Despliega un Monitor que vigile timeouts y disponibilidad de los demás nodos.
Rol de estado (R3) dedicado a la observabilidad operativa. Vigila salud, timeouts, errores y disponibilidad del resto de nodos, y avisa cuando algo se degrada. No toca el trabajo de dominio: su valor es detectar fallos y cuellos de botella a tiempo para que el Agent o el Backup reaccionen.

## Niveles

### N1 · simple
key: level_1_simple
example: N1: una edición trivial de una línea, sin ambigüedad ni riesgo.
Tareas triviales de un solo paso, con requisitos claros y sin ambigüedad, contexto amplio ni riesgo operativo. Se resuelven con el modelo más barato en una única pasada (estrategia de ejecución con un solo modelo), sin división ni revisión humana. Asigna N1 a un único Worker responsable.

### N2 · moderada
key: level_2_moderate
example: N2: un cambio acotado con algo de contexto pero sin decisiones arriesgadas.
Tareas acotadas que requieren algo de contexto o un par de decisiones sencillas, pero siguen resolviéndose de un tirón con un modelo económico. No exigen razonamiento arquitectónico ni conllevan riesgo relevante. Un solo Worker debería ser propietario de este nivel.

### N3 · intermedia
key: level_3_intermediate
example: N3: analizar brevemente el contexto y luego implementar el cambio.
Punto de inflexión: la tarea ya pide entender contexto antes de actuar. La estrategia recomendada es análisis acotado y después ejecución, normalmente con un modelo de gama media. Aparecen varios requisitos o dependencias que hay que ordenar, aunque el riesgo sigue siendo controlable.

### N4 · compleja
key: level_4_complex
example: N4: dividir el trabajo en subtareas y delegarlas en varios Workers.
Trabajo que conviene dividir y delegar: la estrategia es descomponer en subtareas y repartirlas entre Workers, apoyándose en modelos fuertes. Implica razonamiento profundo (arquitectura, concurrencia, rendimiento) o múltiples piezas acopladas. Requiere coordinación explícita del Agent.

### N5 · crítica
key: level_5_critical
example: N5: dividir, delegar y exigir puerta de revisión humana antes de entregar.
Máxima complejidad y/o máximo riesgo operativo. La estrategia es dividir, delegar y exigir revisión humana obligatoria antes de dar nada por bueno. Cubre cambios que pueden afectar a producción, seguridad, coste o permisos, y por defecto activa la puerta de aprobación humana. Reserva N5 para lo que no admite errores silenciosos.

## Restricciones

### Dominio sensible
id: policy:sensitive
group: Restricciones
example: Si el dominio incluye security u operations, exige revisión humana.
Marca dominios que deben bloquearse o pasar por revisión humana: seguridad, operaciones, credenciales, legal o despliegue real. Se apoya en `sensitive_domains`, el umbral `operational_risk_review_threshold` y el nivel mínimo de revisión: si la tarea toca uno de estos dominios o supera el umbral de riesgo, se fuerza la puerta humana antes de ejecutar. Es la primera línea de defensa frente a acciones peligrosas.

### Intención crítica
id: policy:intent
group: Restricciones
example: Si intent = security_architecture_review, aplica puerta humana.
Usa la lista `critical_intents` para señalar intenciones que pueden modificar producción, coste, permisos o seguridad, con independencia del dominio. Cuando la intención clasificada coincide con una crítica (p. ej. revisión de arquitectura de seguridad), la tarea escala a revisión humana aunque su complejidad numérica fuese baja. Captura el "qué pretende hacer" además del "sobre qué".

### Proveedor de pago
id: policy:paid
group: Coste
example: No habilites un proveedor de pago sin aprobación explícita.
Controla el gasto marcando los proveedores de pago como sujetos a aprobación cuando activan modelos fuertes. Con `require_review_for_paid_providers` activo, cualquier ruta que consuma un proveedor facturable requiere confirmación explícita antes de ejecutarse. Evita que una clasificación agresiva dispare coste real sin que un humano lo autorice.

### Credenciales pendientes
id: policy:credentials
group: Credenciales
example: Si falta la API key, genera setup_action y no delegues ejecución real.
Bloquea la ejecución real cuando faltan credenciales: API key ausente, login de CLI pendiente o servicio local no disponible. En lugar de fallar a medias, el sistema genera una acción de configuración (`setup_action`) y no delega ejecución real hasta que la credencial esté lista. Garantiza que nada se ejecute "a ciegas" contra un proveedor no autenticado.
