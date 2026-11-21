# ADR 0002: implementación de referencia por capacidad

Estado: **pendiente de decisión**. Esta nota no autoriza retirar ni sustituir ningún motor.

## Contexto

Python sirve FastAPI, MCP y clientes embebidos; TypeScript se ejecuta como paquete de Atlas y sirve `kj`. Se comparten algunos formatos y bases SQLite, pero existe duplicación de clasificación, perfiles, delegación y analítica, con capacidades no equivalentes. La extracción actual comparte lógica entre transportes TypeScript; Python conserva su motor y frontera embebida, con correcciones en sus controles de producción.

## Alternativas

1. **TypeScript como referencia:** aprovecha los componentes, laboratorios y CLI actuales de Atlas; habría que portar o integrar la ejecución y biblioteca Python que aún no tienen paridad.
2. **Python como referencia:** aprovecha su frontera embebida y capacidades de ejecución y recursos; habría que resolver cómo Atlas Node accede a ellas y trasladar o integrar laboratorios y dosificador.
3. **Referencia por capacidad:** mantener temporalmente los dos motores con contratos explícitos y una implementación propietaria por función; reduce la migración inmediata, pero conserva dos runtimes y su complejidad operativa.

## Evidencia necesaria para decidir

- Inventario de consumidores y capacidades realmente utilizadas, incluido el coste de mantener cada implementación.
- Pruebas de paridad semántica, errores, revisión humana, efectos y atribución por proveedor, usando datos de prueba.
- Pruebas de concurrencia y recuperación del almacenamiento compartido, además de instalación y operación en los equipos previstos.
- Evaluación del impacto de una frontera entre procesos en disponibilidad, permisos y experiencia local.

La referencia se evaluará **por capacidad**, no a partir de que una suite global pase: cada propuesta debe identificar consumidores reales, entradas y salidas, errores, efectos y permisos, persistencia y migración si la hubiera, y evidencia reproducible de paridad o de diferencias aceptadas. La comparación no obliga a que dos capacidades con el mismo nombre ejecuten el mismo algoritmo: clasificar y planificar pueden tener efectos distintos según el motor. Las decisiones de sustitución y retirada requieren una decisión posterior con su propio alcance y plan de compatibilidad.

Hasta completar estas comprobaciones, se mantienen ambas implementaciones y los contratos de sus puntos de entrada. Véanse `arquitectura-transportes.md` e `inventario-interfaces.md` para el mapa actual.
