# Propuesta: autorización entre Atlas dev y Karajan

Estado: **propuesta pendiente de implementación y decisión de despliegue**. Las protecciones actuales siguen vigentes; este documento no acredita permisos diferenciados.

## Problema comprobado

En Atlas dev, `server/src/auth.ts` comprueba un secreto compartido solo cuando `ATLAS_DEV_TOKEN` está configurado. El proxy `server/src/paquetes/rutas.ts` reenvía al paquete el método, el cuerpo y únicamente `content-type` y `accept`; no le entrega la identidad ni las capacidades del solicitante. `server/src/paquetes/paquetes.ts` construye `ContextoPaquete` con `id`, `version` y `datos`. El puente `/karajan` también invoca el paquete en proceso y debe considerarse otra entrada.

En Karajan, `atlas/src/modo.ts` comprueba una tarea aceptada para cambios protegidos. Esa comprobación expresa el estado de una tarea, pero no identifica ni autoriza al solicitante. En la delegación existe revisión humana para determinadas tareas, pero `human_approved` es un dato aportado por el cliente, no prueba independiente de la identidad de quien aprobó. La creación de borradores y la ejecución de proveedores no reciben un permiso diferenciado del host.

No es posible implementar permisos por identidad fiables solo con el contrato actual del paquete: un identificador, una lista de permisos o un booleano en el cuerpo pueden ser inventados por el cliente. El paquete tampoco puede saber si el host ha comprobado un token que no recibe. En consecuencia, activar un control nuevo sin cambiar el host obligaría a rechazar operaciones legítimas o daría una falsa sensación de seguridad. La ausencia de `ATLAS_DEV_TOKEN` deja además abierta la frontera compartida actual.

## Contrato propuesto

1. **Identidad en el host.** Atlas debe autenticar cada llamante sensible con un mecanismo configurado y verificable. El secreto compartido actual puede identificar una integración de servicio, pero no identifica por sí mismo a una persona ni distingue clientes que lo comparten. Para atribuir acciones a personas hace falta una identidad individual y una fuente de permisos verificada; no derivar el actor de cabeceras arbitrarias. En un despliegue sin identidad configurada, las operaciones protegidas deben fallar de forma explícita y accionable, manteniendo el acceso de lectura acordado.
2. **Permisos explícitos.** Definir y documentar como mínimo capacidades separadas para ejecutar proveedores, modificar configuración/perfiles, mover o instalar skills y crear borradores. Distinguir lectura, planificación y ejecución real. El estado de una tarea aceptada y la revisión humana son controles adicionales, no sustitutos de estos permisos. La aprobación humana debe consultarse en un registro confiable ligado a la tarea, su acción y su versión, no obtenerse de `human_approved`.
3. **Contexto fiable host → paquete.** Ampliar el contrato del host para entregar a Karajan, por cada petición, un contexto autenticado `{ actor, capacidades, origen }`. El host debe ignorar cualquier identidad o permiso declarados por el cliente. El proxy de `/paquetes/:id/api/*` y el puente `/karajan` deben utilizar el mismo mecanismo de creación del contexto. Preferir un canal interno no accesible al solicitante y documentar su frontera de confianza; si se emplea una aserción firmada, verificar firma, emisor, audiencia, caducidad y vinculación a la petición, así como evitar repeticiones y proteger la clave. No basta con reenviar cabeceras sin verificar.
4. **Comprobación en la aplicación.** En Karajan, introducir un contexto operativo explícito y validar la capacidad antes de cada efecto en las capas `aplicacion.ts`, `aplicacion-laboratorio.ts` y los servicios que usen directamente otros adaptadores. El transporte traduce la identidad verificada y los errores; no concede permisos por su cuenta. La ejecución directa debe construir su propio contexto autenticado y no tener un acceso privilegiado implícito. Mantener `Guardian` como condición adicional para las mutaciones en producción.
5. **Fallos y compatibilidad.** Definir respuestas estables y comprobables: ausencia o invalidez de credencial, permiso insuficiente, tarea no aceptada y dependencia de Atlas inaccesible deben ser distinguibles. No pasar a otro transporte ni crear un borrador como efecto de una petición no autorizada. Actualizar los consumidores del puente, la UI y `kj` antes de exigir el nuevo contrato. Documentar el cambio de contratos y la configuración, con despliegue coordinado de host y paquete; no afirmar soporte de autorización diferenciada hasta que ambos extremos estén activos.

## Lugares que requieren cambios

| Proyecto | Lugar | Responsabilidad propuesta |
|---|---|---|
| Atlas dev | `server/src/auth.ts`, `server/src/server.ts` | Autenticar y resolver identidad y capacidades; definir política para configuración ausente. |
| Atlas dev | `server/src/paquetes/rutas.ts`, `server/src/paquetes/paquetes.ts` | Crear y transferir contexto fiable por petición al paquete, sin aceptar permisos aportados por el cliente. |
| Atlas dev | `server/src/karajan/rutas.ts`, `server/src/integraciones/comun.ts` | Aplicar el mismo control y propagación en el puente y las invocaciones internas. |
| Karajan | `atlas/src/runtime.ts`, `aplicacion.ts`, `aplicacion-laboratorio.ts`, `modo.ts` | Autorizar las operaciones sensibles en la capa común y conservar la tarea aceptada como guarda adicional. |
| Karajan | `atlas/src/cli.ts`, `atlas/src/sdk/`, consumidores Atlas y pruebas | Propagar contexto según el contrato elegido y conservar explícitos los transportes y errores. |

Las rutas son puntos de partida identificados en el código actual; la implementación debe inventariar también los accesos indirectos y los temporizadores que puedan producir efectos.

## Pruebas de aceptación necesarias

- Probar por la ruta directa del paquete y por el puente, con identidades autorizadas, sin credencial, con credencial inválida y sin cada capacidad relevante. Comprobar el código y que no haya ejecución, movimiento, cambio de configuración ni borrador ante denegación.
- Intentar falsificar actor, capacidades y aprobación mediante cabeceras y cuerpo; demostrar que no conceden permisos. Probar una aprobación válida y otra de una tarea distinta o modificada.
- En producción, demostrar que una identidad autorizada sigue necesitando tarea aceptada donde corresponda y que una tarea aceptada no suple la falta de permiso. Comprobar desarrollo y acceso directo de terminal con su identidad explícita.
- Verificar que se conservan rutas, respuestas y funcionalidad de clientes autorizados; documentar cualquier cambio inevitable. Probar la indisponibilidad del proveedor de identidad y de Atlas sin degradación silenciosa.
- Ejecutar integración con host y paquete reales, bases temporales, solicitudes concurrentes y, si hay aserciones firmadas, expiración, audiencia, manipulación y repetición. No ejecutar proveedores reales en la suite: usar un ejecutor controlado que permita demostrar si se invocó.

## Dependencia de otros proyectos

Los cambios del host deben realizarse en el repositorio de Atlas dev y desplegarse conjuntamente con Karajan. Una modificación solo de Karajan puede restringir operaciones, pero no crear una identidad confiable que el host no proporciona. El diseño de identidad y la transición requieren verificar los consumidores reales antes de retirar la compatibilidad anterior.
