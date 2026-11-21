# Verificación final de especialistas — t3kn

Fecha: 2026-11-20. Rama: `agente/t3kn`. Referencias: [manual](especialistas.md), [análisis de biblioteca](especialistas-analisis.md).

## Resultados reproducidos

| Comprobación | Resultado |
| --- | --- |
| `node atlas/ejecutar-tests.mjs` | 432 pruebas correctas, 85 suites, cero fallos, canceladas u omitidas. |
| `node atlas/build.mjs` | Correcto. |
| TypeScript con `strictNullChecks`, módulos de especialistas y su prueba | Correcto. |
| `npm.cmd audit --prefix atlas --json` | Cero vulnerabilidades. |
| `node scripts/medir-especialistas.mjs` | 40 definiciones, 921 skills sintéticas, 4.000 selecciones, una lectura del inventario. |

Medición indicativa con carga concurrente en esta máquina: coincidencia p50 0,418 ms / p95 0,790 ms; sin coincidencia p50 0,265 ms / p95 0,460 ms. No mide la preparación de skills ni la ejecución de modelos.

La prueba nueva en `atlas/tests/especialistas.test.ts` usa `Delegador.delegar`, descubrimiento y `Rotador` reales sobre una carpeta temporal. Parte de `pdf`, `graphify` y `networkx` únicamente en el almacén de `agents`; comprueba su reposición para Codex antes de ejecutar, el modelo especializado de la primera subtarea y los modelos base de las restantes. Comprueba también que las reposiciones no se registran como uso confirmado. El ejecutor es simulado: no se lanzan modelos ni se modifica la biblioteca instalada.

La suite completa mantiene las comprobaciones de configuración corrupta, respaldo, desactivación, ausencia de cobertura, empate, composición con sugerencias sueltas, fallos de preparación, bloqueos originales, CLI, API, guardián, perfiles, selector y rotación.

## Límites

La instantánea de biblioteca conserva sus 971 entradas y su hash de catálogo verificado por la suite. Disponibilidad documental y local no equivalen a tener instaladas todas las herramientas científicas, servicios o cuentas. No se afirma una mejora de calidad medida con modelos reales. La superficie implementada es TypeScript y el puente Atlas dev; no se añadió paridad de especialistas al servidor Python independiente.

El contraste R01–R20, las pruebas de cola/proyectos y la presentación se conservan en el repositorio Atlas dev, en `docs/proyectos/t3kn-cierre-agentes-especializados.md`, junto al plan aprobado.
