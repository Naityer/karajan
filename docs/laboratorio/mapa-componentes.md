# Mapa de implementación, laboratorios y pruebas

Esta guía conecta la definición de cada componente con su código y con las pruebas relacionadas. La definición ejecutable de responsabilidades y dependencias está en [`atlas/src/componentes.ts`](../../atlas/src/componentes.ts); las fichas de entradas y salidas están en [`fichas-componentes.ts`](../../atlas/src/fichas-componentes.ts). Los laboratorios miden escenarios concretos y no certifican por sí solos todas las rutas ni permisos. Los nombres «pendiente» son los declarados por el catálogo, no una prueba de que exista una implementación.

Las rutas de la tabla son relativas a `atlas/`. La prueba de arquitectura [`tests/arquitectura.test.ts`](../../atlas/tests/arquitectura.test.ts) comprueba la asignación de módulos y relaciones entre componentes; [`tests/arquitectura-datos.test.ts`](../../atlas/tests/arquitectura-datos.test.ts) comprueba su proyección de datos.

| Componente | Implementación principal | Laboratorio | Pruebas relacionadas |
|---|---|---|---|
| almacén | `src/almacen.ts` | `src/lab/almacen.lab.ts` | `tests/contrato.test.ts`, `tests/sqlite-procesos.test.ts` |
| biblioteca | `src/biblioteca.ts` | `src/lab/biblioteca.lab.ts` | `tests/inspiration-api.test.ts`, `tests/inspiration.test.ts` |
| modo | `src/modo.ts`, `src/atlas-dev.ts` | Sin laboratorio propio; pruebas unitarias | `tests/modo.test.ts` |
| pasarela | `src/pasarela-borradores.ts` | Sin laboratorio propio; pruebas unitarias | `tests/pasarela.test.ts` |
| laboratorio | `src/laboratorio.ts`, `src/arquitectura.ts`, `src/componentes.ts` | Es el motor de los laboratorios | `tests/laboratorio.test.ts`, `tests/arquitectura.test.ts` |
| clasificador | `src/heuristica.ts` | `src/lab/clasificador.lab.ts` | `tests/paridad.test.ts` |
| delegador | `src/delegar.ts`, `src/perfiles.ts`, `src/reglas.ts`, `src/perfil-texto.ts` | `src/lab/delegador.lab.ts` | `tests/contrato.test.ts`, `tests/perfiles.test.ts`, `tests/perfil-texto.test.ts` |
| dosificador | `src/dosificador.ts`, `src/dosificador-config.ts`, `src/dosificador-cuota.ts`, `src/dosificador-sim.ts` | `src/lab/dosificador.lab.ts` | `tests/dosificador.test.ts`, `tests/dosificador-api.test.ts`, `tests/dosificador-sim.test.ts`, `tests/dosificador-relevo.test.ts` |
| selector | `src/skills-seleccion.ts` | `src/lab/selector.lab.ts` | `tests/skills-seleccion.test.ts`, `tests/panel-skills.test.ts` |
| rotador | `src/rotador.ts` | `src/lab/rotador.lab.ts` | `tests/rotador.test.ts`, `tests/rotador-lab.test.ts` |
| tutor | `src/tutor.ts` | `src/lab/tutor.lab.ts` | `tests/tutoria.test.ts`, `tests/laboratorio.test.ts` |
| etiquetas | No tiene módulos propios en este paquete; se declara en Atlas dev | Pendiente en el catálogo | Comprobar el repositorio y pruebas de Atlas dev |
| proveedores | `src/proveedores.ts` | `src/lab/proveedores.lab.ts` | `tests/labs-ejecucion-observacion.test.ts`, `tests/contrato.test.ts` |
| límites | `src/limites.ts` | `src/lab/limites.lab.ts` | `tests/limites.test.ts`, `tests/labs-ejecucion-observacion.test.ts` |
| aislamiento | `src/aislar-git.ts` | `src/lab/aislamiento.lab.ts` | `tests/aislar-git.test.ts`, `tests/labs-ejecucion-observacion.test.ts` |
| analítica | `src/analitica.ts`, `src/catalogo.ts` | `src/lab/analitica.lab.ts` | `tests/contrato.test.ts`, `tests/labs-ejecucion-observacion.test.ts` |
| producción | `src/produccion.ts` | `src/lab/produccion.lab.ts` | `tests/produccion.test.ts`, `tests/labs-ejecucion-observacion.test.ts` |
| tutoría | `src/tutoria.ts`, `src/tutoria-nota.ts`, `src/skillforge.ts` | `src/lab/tutoria.lab.ts` | `tests/tutoria.test.ts` |
| curador | `src/curador.ts` | `src/lab/curador.lab.ts` | `tests/curador.test.ts` |
| comparador | `src/comparador.ts` | `src/lab/comparador.lab.ts` | `tests/comparador.test.ts` |
| eficiencia | `src/eficiencia.ts` | `src/lab/eficiencia.lab.ts` | `tests/modificadores.test.ts` |
| método | `src/metodo.ts` | `src/lab/metodo.lab.ts` | `tests/modificadores.test.ts` |
| prompts | `src/prompts.ts` | `src/lab/prompts.lab.ts` | `tests/modificadores.test.ts` |
| API y composición | `src/servidor.ts`, `src/runtime.ts`, `src/aplicacion*.ts` | Sin laboratorio propio; integra componentes | `tests/aplicacion.test.ts`, `tests/runtime.test.ts`, `tests/contrato.test.ts` |
| CLI | `src/cli.ts`, `src/cli-local.ts`, `src/sdk/` | Sin laboratorio propio | `tests/cli.test.ts`, `tests/control.test.ts`, `tests/sdk.test.ts` |

Para los puntos de entrada Python, MCP y las diferencias entre motores, véase [matriz de capacidades y contratos](../matriz-capacidades-contratos.md). Para las rutas locales y HTTP véase [arquitectura de transportes](../arquitectura-transportes.md). La interfaz `dashboard/` es la anterior congelada; `atlas/ui/` es la UI del paquete Atlas y `dist-atlas/` es una salida generada.
