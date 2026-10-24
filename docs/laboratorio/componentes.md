# Karajan como procesador de componentes, con laboratorio por componente

Karajan ya está en **producción** como paquete de Atlas dev (`atlas/`). Cada tarea pasa por tres decisiones:

- a qué agente va (el **delegador**);
- con qué skills (el **selector**);
- qué skills se quedan instaladas (el **rotador**).

Este documento fija cómo se organiza para poder **medir** esas decisiones con datos reales y evolucionarlas sin tocar producción a ciegas.

## 1. La pila

Funciona como un procesador por capas. Cada componente tiene **una sola responsabilidad** y sus módulos son solo suyos.

```
┌ Interfaz ───────── cli (kj) · api
├ Modificadores ──── curador · comparador · eficiencia (ponytail) · método (superpowers) · prompts (karpathy-skills/dspy/promptfoo)
├ Observación ────── analítica · producción
├ Ejecución ──────── proveedores · límites · aislamiento
├ Decisión ───────── clasificador · delegador · selector · rotador · etiquetas (atlas-dev)
└ Base ───────────── almacén · biblioteca · modo · pasarela · laboratorio
```

- La declaración vive en `atlas/src/componentes.ts`: id, capa (= `familia`, con su `orden` de pintado), responsabilidad, módulos y laboratorio, o `pendiente` si aún no lo tiene. `kj componentes` la pinta con el estado del último laboratorio de cada uno.
- `ENLACES` (mismo fichero) declara el flujo de datos entre componentes (`clasificador → delegador → proveedores`, `modo → pasarela`…), solo lo que el código respalda; los que traerá un borrador llevan `previsto`. El test de arquitectura comprueba que sus extremos existen.
- `atlas/src/fichas-componentes.ts` guarda la ficha de cada uno (resumen, entradas → pasos → salidas con el fichero que implementa cada paso, reglas y configuración viva). `especificado: false` marca los que aún no tienen código.
- El test `atlas/tests/arquitectura.test.ts` hace cumplir la responsabilidad única:
  - cada módulo de `src/` pertenece a un solo componente;
  - cada componente tiene laboratorio o dice qué borrador lo trae;
  - un laboratorio solo importa su componente y la capa base.

## 2. El laboratorio

El motor está en `atlas/src/laboratorio.ts` y los laboratorios en `atlas/src/lab/<componente>.lab.ts`. Un laboratorio es una lista de escenarios de tres tipos:

| Tipo | Qué mide |
|---|---|
| `contrato` | Invariantes del componente sobre su configuración real (p. ej. «cada decisión sale de una regla del perfil») |
| `replay` | Sus decisiones **a ciegas** frente a las de la persona, sobre las tareas reales de Atlas dev |
| `feedback` | Sus decisiones frente a las correcciones humanas registradas (el sí/no de «Preparando») |

Cada escenario devuelve la muestra, si es **suficiente**, sus métricas, los umbrales y los **hallazgos**.

**Reglas del laboratorio**
- **No muta producción.**
  - El delegador del laboratorio solo planifica, con todos los agentes «disponibles» y sin límites: se mide el perfil, no la máquina.
  - Los resultados van a `<datos del paquete>/laboratorio/laboratorio.db`, no al `task_logs.db` compartido.
- **A ciegas y anónimo.**
  - Las tareas se leen de `GET /operaciones/tareas` de Atlas dev. Se cambia el id por un hash con sal local y se descartan título, repo, rama y hoja.
  - El prompt solo vive en memoria.
  - Las tareas en `auto` (elegidas por Karajan) no cuentan como elección humana; solo se usan para el control de determinismo.
  - Las propuestas del propio Karajan (`Origen: karajan:`) se excluyen.
- **Sin conclusiones con muestra corta.** Cada laboratorio fija su muestra mínima. Por debajo da métricas, pero no saca hallazgos de ellas. Las proporciones se juzgan por su intervalo de Wilson al 95 %, no por el valor puntual.
- **Los hallazgos no cambian nada.** Los `alta|media` salen como **borradores** en la cola de Atlas dev (ver §4); los `baja` se quedan en el informe.

### Laboratorios que existen

| Componente | Escenarios | Qué decide un hallazgo |
|---|---|---|
| delegador | `fidelidad` (contrato), `concordancia` (replay), `adecuacion` (replay), `determinismo` (contrato) | Distingue **hacer bien su función** (decisiones trazables, reglas tapadas o sin uso, niveles sin agente, mismo plan para el mismo prompt) de que **el perfil sirva**. En `adecuacion`, un segmento dominio×nivel es inadecuado si n ≥ 10, el IC95 inferior de la discrepancia con la persona es > 0.3 y la elección de la persona salió bien en ≥ 70 % de esos casos. Entonces propone un **perfil nuevo**: reglas por mayoría de lo que funcionó, descripción generada y layout validado. |
| selector | `explicitas` (contrato), `concordancia` (replay), `calibracion` (feedback) | Verdad humana, por orden de fiabilidad: sí/no de Preparando, `skills_usadas` revisadas, skills de la hoja en tareas no `auto`. Mide Hit@1, precisión@3, recall@3 y falsos positivos. Con n ≥ 30 busca pesos (`PESOS_SELECTOR`) con validación cruzada de 5 pliegues y solo los propone si el F1 **en datos no vistos** sube ≥ 5 pp sin bajar Hit@1. |
| clasificador | `frente-a-la-persona` (replay) | Nivel y dominio frente a los que la persona anota en la hoja (`clasificacion.nivel_tarea`, `dominio`). |
| rotador | `contrato` (contrato), `historial` (replay) | Contrato: días coherentes (instantánea < núcleo < frecuente), protegidas fuera del plan de retirar, nada instalado y en el almacén del mismo destino, plan idempotente (aplicado en una casa ficticia da un plan vacío). `historial` reproduce día a día el uso real (Atlas dev `dias` + ejecuciones de Karajan con fecha) en un sandbox temporal con el `Rotador` de verdad y `ahora` simulado, y mide fallos (la skill hacía falta y estaba en el almacén), skills instaladas de media y movimientos para una rejilla de (núcleo, frecuente). Propone otros días (hallazgo media) solo con ≥ 90 días de historial y ≥ 40 usos, y si mejoran ≥ 15 % un eje (≥ 3 fallos menos, o ≥ 1 skill menos) sin empeorar el otro más de 5 %. Solo `frecuenteDias` decide qué se retira; el núcleo es una etiqueta. |
| biblioteca | `cobertura` (contrato) | Cuántas skills del equipo tienen ficha, estrellas propias (no heredadas) y grupo. Es la base de datos sobre la que decidirán el curador y el comparador. |
| curador | `invariantes` (contrato), `precision` (feedback) | Propone qué skills sobran con 4 reglas (`sin-uso-ni-recomendacion` 90 d con registro suficiente, `duplicada`, `sin-descripcion`, `superada-por-grupo` con estrellas propias < 100 y rival usado ≥ 10×); nunca protegidas ni estrellas heredadas. `invariantes`: determinismo, ninguna protegida, regla y evidencia en cada propuesta. `precision`: borradores aceptados frente a descartados, Wilson, n ≥ 20 (≥ 10 por regla para el hallazgo). `GET /laboratorio/curador`, `POST /laboratorio/curador/proponer`, `kj curador`. |
| eficiencia · metodo · prompts | `contrato` (contrato), `replay-ab` (replay), `feedback` (feedback) — comunes, en `ab.ts` | Cada modificador (`eficiencia.ts` ponytail, `metodo.ts` superpowers, `prompts.ts` karpathy-skills/dspy/promptfoo) es una función pura que añade un bloque a la instrucción; **desactivado en producción** (devuelve la instrucción intacta) y **sin conectar al delegador** (los enlaces `→ delegador` siguen `previsto` hasta un borrador que los enganche solo en desarrollo). `contrato`: idempotente, conserva el texto, sobrecoste acotado, no-op en producción. `replay-ab`: **observacional, no aleatorizado** — tareas cuya hoja llevaba la skill del modificador (A) frente al resto comparable (B: mismo dominio×nivel, si no hoja escrita a mano, si no el resto); acierto y re-trabajo con Wilson; concluye solo con ≥ 20 tareas terminadas por brazo y IC95 sin solaparse, y entonces propone activar o retirar como borrador. `feedback`: si ≥ 20 calibraciones y el IC95 superior de aceptación < 0,5, propone retirarlo. |
| almacen | `integridad` (contrato), `ida-y-vuelta` (contrato) | Solo lectura sobre `task_logs.db`: runs y decisiones huérfanos y estados fuera del conjunto válido (alta si hay), fechas ilegibles o invertidas (baja); y en un registro temporal, que escribir y leer da lo mismo (alta si no). |
| proveedores | `contrato` (contrato), `fallos` (replay) | Tabla completa y binarios encontrados con `buscarBinario` sin ejecutarlos (falta = baja). Sobre los runs registrados, tasa de fallo por proveedor con Wilson (≥ 10 runs) y motivos agrupados con `motivoFallo`: media si el IC95 inferior de uno supera el superior del resto. |
| limites | `fichero` (contrato), `decision` (contrato) | Sin tocar `limites-plan.json`: existe, no caducado (≤ 2 h), umbral en (0, 100] y % semanal en [0, 100]; y `claudeExcedido` coincide con «% semanal > umbral», bordes incluidos (alta si no). |
| aislamiento | `ciclo` (contrato), `huerfanos` (contrato) | En un repo git temporal: `aislar` crea worktree y rama `agente/<id>`, `cerrar` commitea con trailers, quita el worktree y no mueve main (alta si falla). En solo lectura sobre el Workspace: worktrees sin carpeta y ramas `agente/*` ya integradas (baja). |
| analitica | `coherencia` (contrato) | Solo lectura: por skill usadas ≤ preparadas (media) y preparadas vs recomendadas (baja); los totales (ejecuciones, éxitos + fallos, línea de tiempo, tareas delegadas) cuadran entre sí y con el almacén (alta). |
| produccion | `concordancia` (replay) | Acierto y re-trabajo de `produccion.ts` frente al estado final de la persona en Atlas dev y frente a las tareas que además revisó. Con ≥ 30 terminadas (15 revisadas) y Wilson: media si el IC95 superior de la concordancia queda bajo 0,7. |
| comparador | `estrellas-propias` (contrato), `pruebas-y-funcionalidades` (contrato) | Compara cada skill y a Karajan con los 5 mejores de su grupo **solo con estrellas propias** y un grupo con ≥ 5 recursos con estrellas propias (si no, «sin dato»). Un hallazgo `media` por cada prueba de ejecución real con feedback humano (evals, benchmarks, A/B, feedback humano, preferencia, regresión de prompts) que declara algún par top y Karajan no tiene en sus laboratorios (`replay` y `feedback` ya cubren preferencia y feedback humano); otro `media` por las funcionalidades (palabras clave declaradas, no comunes a la biblioteca) que ofrecen ≥ 3 de los 5 pares top; con 2 pares, `baja`. |

## 3. Modo producción

`<datos>/modo.json` vale `{"modo":"produccion"}`: el paquete lo escribe al arrancar si no existe, y el Karajan nativo lee el mismo fichero.

- **No se cambia por API**: solo editando el fichero.
- En producción, las mutaciones de configuración necesitan el id de una **tarea aceptada** de Atlas dev (`encolada` o `ejecutando`) en la cabecera `x-karajan-tarea`:
  - en el paquete: `PUT /routing-layout`, los presets, `desde-texto` con `aplicar` y `skills/rotar` con `aplicar`;
  - en el nativo: además `PUT /config`, `setup/apply-*`, el catálogo del lienzo e `install` de skills.
- Sin esa tarea responde **423** y el paquete deja la mutación pedida como borrador.
- Siguen libres clasificar, planificar, delegar, el feedback y el laboratorio, porque solo proponen o registran.

## 4. Pasarela de borradores

`atlas/src/pasarela-borradores.ts` es la única salida de Karajan para proponer un cambio.

- Cada hallazgo se convierte en una tarea **borrador** de Atlas dev (`POST /operaciones/tareas`) con su especificación: Evidencia, Propuesta, Criterios y `Origen: karajan:<componente>:<clave>`.
- Es idempotente por clave (`laboratorio/borradores.json`):
  - si sigue en borrador, se actualiza;
  - lo que la persona **descartó no se reabre**;
  - lo aceptado no se toca.
- `kj propuestas` lista lo abierto y su estado.

## 5. Terminal en lugar de interfaz

El dashboard Python (`dashboard/static`) queda **congelado**: no evoluciona y se retirará (borrador). Todo se maneja con `kj` (`node dist-atlas/kj.mjs`, ver `docs/CLI.md`):

```
kj componentes                                   kj lab run <componente|todos> [--escenario x] [--sin-borradores]
kj lab ls                                        kj lab informe <componente>
kj lab historial <componente> <métrica>          kj grafica acierto|eficiencia|flujo|matriz-skills|sugerencias [--dias N]
kj propuestas                                    kj modo                       (--json en todos)
```

## 6. Skills que pueden ser piezas (análisis sobre `resources.db`, 2026-10-21)

Estrellas: «propias» si la ficha es del repo; «heredadas» si la skill está dentro de una colección y la cifra es la de la colección, que no dice nada de esa skill.

| Pieza (componente) | Skill(s) | Estrellas | Estado en el equipo | Encaje |
|---|---|---|---|---|
| eficiencia | ponytail | 120 k (propias) | instalada y protegida | Mide su propio efecto (−54 % de código en su README): es un A/B natural sobre tareas reproducidas. |
| método | superpowers: test-driven-development, writing-plans, executing-plans, subagent-driven-development, using-git-worktrees, brainstorming | 278 k (**heredadas** de la colección; obra/superpowers) | no instalada | Paquete de trabajo completo (plan → TDD → ejecución → rama); encaja como modificador de N3–N5. |
| prompts | karpathy-skills | **no está en la biblioteca** | — | Hay que ingerirla antes de valorarla (`/resources/ingest-url`). |
| prompts | dspy | 38 k (propias) | no instalada (es framework) | Optimización programática de prompts; candidata para el selector y la instrucción de delegación. |
| prompts / evaluación | promptfoo | 25 k (propias) | skill en la biblioteca | Evals y regresión de prompts: el arnés natural de los laboratorios de modificadores. |
| calibración | arbor | 44 k (heredadas; k-dense scientific-agent-skills) | no instalada | Hypothesis Tree Refinement: mejorar un artefacto frente a un evaluador **sin sobreajustar**. Es justo el bucle del selector y el delegador. |
| diseño del laboratorio | experimental-design, statistical-power | 44 k (heredadas) | no instaladas | Tamaño de muestra y diseño de los A/B de los modificadores. |
| evaluación de skills | skill-creator | 175 k (heredadas; anthropics/skills) | instalada | Trae evals y benchmark de skills: base del comparador. |

**Pares de Karajan** en su grupo de la taxonomía (`agents_orchestration`): ecc (246 k), dify (155 k), gstack (131 k), headroom (71 k) y dspy (38 k). Compararse con ellos es el trabajo del componente comparador (borrador).

**Defectos de datos** que condicionan cualquier decisión sobre la biblioteca:
- Las **estrellas heredadas**: toda skill anidada lleva las de su colección.
- La **taxonomía**: 657 de 1235 recursos activos caen en `quality_testing`, que hace de cajón de sastre, y hay asignaciones raras (superpowers en `quality_testing`, ponytail-audit en `agents_extensions`).
- El laboratorio `biblioteca` lo mide, y el borrador del comparador incluye arreglarlo antes de decidir con esos datos.

## 7. Lo que queda (borradores en Atlas dev)

Hecho en 0.9.0 (tarea j0co): laboratorios del rotador, curador, comparador, modificadores (eficiencia, método, prompts) y de
ejecución y observación (almacén, proveedores, límites, aislamiento, analítica, producción); `kj curador`, `kj comparar`,
`kj grafica … --svg/--html`, y el panel sí/no de skills montable (`window.AtlasPaquetes.karajan.panelSkills`, ver
[preparado-si-no.md](preparado-si-no.md)). Lo que sigue va como borrador en la cola de Atlas dev, nunca como cambio directo:

| Borrador | Repo |
|---|---|
| Montar el panel sí/no de skills en la fase «preparado» (`PanelPreparado`, `detalle-fases.tsx`) según [preparado-si-no.md](preparado-si-no.md) | atlas-dev |
| Claude no recibe las skills de la hoja (`contenidoClaude` ignora `envio.skills`) | atlas-dev |
| Componente etiquetas (cabecera «Atlas dev · tarea <id>» y glosario) bajo el contrato, alineado con «Planificador como componente de karajan» | atlas-dev |
| Paquete de trabajo completo: skills que encajan como piezas de componentes (especificación, ver §6) | karajan |
| Conectar los modificadores al delegador, solo en desarrollo (los enlaces `eficiencia/metodo/prompts → delegador` siguen «previstos») | karajan |
| Registrar cada reposición del rotador con fecha (para calibrar `instantaneaDias`; hoy solo `frecuenteDias` decide qué se retira) | karajan |
| Fechas relativas en `TareaAnonima` para que el laboratorio de producción recalcule el acierto con `calcularAcierto` | karajan |
| Resolver el repo de origen y las estrellas propias de las skills anidadas y re-ingerir las 251 skills sin ficha (sin eso el comparador solo puntúa 2 de 441) | karajan |
| Retirar el dashboard Python (las gráficas ya se exportan desde `kj`) | karajan |

## 8. Ventana de Atlas dev

La ventana «Arquitectura» de Atlas dev se alimenta de dos rutas de solo lectura (`atlas/src/arquitectura.ts`; no escriben nada y no lanzan: una fuente que falla deja su campo a `null` y lo anota en `avisos` del componente).

| Ruta | Qué da |
|---|---|
| `GET /laboratorio/arquitectura` | Todo el contrato: `{version_contrato, version, modo, generado, familias[], componentes[], enlaces[]}` |
| `GET /laboratorio/arquitectura/:id` | Un componente con el `historial` completo (hasta 500 puntos por métrica) y el `detalle` dentro de cada `ultima`; 404 si no existe |

Cada componente trae: `id`, `familia`, `responsabilidad`, `modulos`, `estado` (`ok` · `hallazgos` · `sin_ejecutar` · `pendiente` · `error`, con la lógica de `estadoDe` de `cli.ts`), `muestra_corta`, `pendiente`, `ficha`, `configuracion` (la viva), `escenarios` (con los umbrales de la última ejecución), `ultimas`, `historial` (por métrica, las últimas 30 ejecuciones, de más antigua a más reciente, sin valores nulos), `detalle` (por escenario, de su última ejecución), `hallazgos` (con su borrador y el estado que tiene en Atlas dev), `operacion` (tareas, runs, latencia p50, coste, tokens y última actividad desde `task_logs.db`, más un `extra` propio de cada componente) y `avisos`.

**Ejecutar desde la ventana y el proxy de Atlas dev.** El proxy del paquete (`server/src/paquetes/rutas.ts`, en atlas-dev) solo reenvía las cabeceras `content-type` y `accept`, así que `x-karajan-tarea` no llega al paquete. Por eso la ventana manda el id de la tarea **en el cuerpo**: `{"componente": "delegador", "proponer": false, "tarea": "<id>"}`. El guardián de modo (`Guardian.tareaDe`) acepta el id indistintamente en la cabecera o en `body.tarea`; la cabecera tiene prioridad. `POST /laboratorio/ejecutar` no cambia configuración y no pasa por el guardián, pero el resto de mutaciones (`PUT /routing-layout`, presets, `desde-texto` con `aplicar`, `skills/rotar` con `aplicar`) sí, y con el id en el cuerpo funcionan igual a través del proxy. La ventana manda `proponer: false` para que ejecutar solo mida (sin ese campo, el servidor sí propone los hallazgos `alta|media` como borradores).

