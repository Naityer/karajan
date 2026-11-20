import type { Laboratorio } from './laboratorio';
import { laboratorioAlmacen } from './lab/almacen.lab';
import { laboratorioAislamiento } from './lab/aislamiento.lab';
import { laboratorioAnalitica } from './lab/analitica.lab';
import { laboratorioBiblioteca } from './lab/biblioteca.lab';
import { laboratorioComparador } from './lab/comparador.lab';
import { laboratorioClasificador } from './lab/clasificador.lab';
import { laboratorioCurador } from './lab/curador.lab';
import { laboratorioDelegador } from './lab/delegador.lab';
import { laboratorioDosificador } from './lab/dosificador.lab';
import { laboratorioEficiencia } from './lab/eficiencia.lab';
import { laboratorioMetodo } from './lab/metodo.lab';
import { laboratorioPrompts } from './lab/prompts.lab';
import { laboratorioLimites } from './lab/limites.lab';
import { laboratorioProduccion } from './lab/produccion.lab';
import { laboratorioProveedores } from './lab/proveedores.lab';
import { laboratorioRotador } from './lab/rotador.lab';
import { laboratorioSelector } from './lab/selector.lab';
import { laboratorioEspecialistas } from './lab/especialistas.lab';
import { laboratorioTutor } from './lab/tutor.lab';
import { laboratorioTutoria } from './lab/tutoria.lab';

/**
 * Karajan como procesador de componentes (ver docs/laboratorio/componentes.md). Cada componente tiene UNA responsabilidad,
 * unos módulos que son solo suyos y su laboratorio, que mide esa responsabilidad con datos reales. Los que aún no lo tienen
 * dicen qué borrador lo trae (`pendiente`). El test de arquitectura comprueba que cada módulo de `src/` pertenece a un solo
 * componente y que cada laboratorio solo importa su componente y la capa base.
 */
export type Capa = 'base' | 'decision' | 'ejecucion' | 'observacion' | 'modificadores' | 'interfaz';
export const CAPAS: { id: Capa; nombre: string }[] = [
  { id: 'interfaz', nombre: 'Interfaz' }, { id: 'modificadores', nombre: 'Modificadores' }, { id: 'observacion', nombre: 'Observación' },
  { id: 'ejecucion', nombre: 'Ejecución' }, { id: 'decision', nombre: 'Decisión' }, { id: 'base', nombre: 'Base' },
];

/** Las capas vistas como familias de la ventana de Atlas dev: mismo id, nombre y `orden` de pintado (0 = arriba, 5 = abajo). */
export type Familia = Capa;
export const FAMILIAS: { id: Familia; nombre: string; orden: number }[] = CAPAS.map((c, orden) => ({ ...c, orden }));

export interface Componente {
  id: string; capa: Capa;
  /** La familia con la que la ventana de Atlas dev agrupa el componente (por ahora, su capa). */
  familia: Familia;
  responsabilidad: string;
  /** Módulos de `src/` (sin extensión) que son de este componente. */
  modulos: string[];
  laboratorio?: Laboratorio<any>;
  /** Si aún no tiene laboratorio (o no existe todavía): qué lo trae. */
  pendiente?: string;
  /**
   * De qué otros componentes depende EN EJECUCIÓN (imports reales entre sus módulos, sin contar los `import type` ni los módulos
   * compartidos). Es una declaración comprobada: arquitectura.test.ts falla si el código importa a otro componente que no esté aquí,
   * o si aquí figura uno que no se importa. `'todos'` es para las raíces de composición (`api`, `laboratorio`), que enchufan a todos.
   */
  requiere: string[] | 'todos';
  /** Dónde se lee y (si se puede) se escribe su configuración, como rutas del paquete; sin `escritura` es de solo lectura. */
  config?: { lectura: string; escritura?: string };
}

/** Módulos de `src/` que no son de ningún componente: utilidades puras que cualquiera puede importar. */
export const COMPARTIDOS = ['redondeo', 'estadistica'];

const DEFINICION: Omit<Componente, 'familia'>[] = [
  // ── Base ──
  { id: 'almacen', capa: 'base', responsabilidad: 'Guardar y leer el registro de tareas, decisiones, runs y revisiones', modulos: ['almacen'], requiere: [], laboratorio: laboratorioAlmacen },
  { id: 'biblioteca', capa: 'base', responsabilidad: 'Dar la ficha de una skill (estrellas, repo, taxonomía) desde resources.db, en solo lectura', modulos: ['biblioteca'], requiere: [], laboratorio: laboratorioBiblioteca },
  { id: 'modo', capa: 'base', responsabilidad: 'Bloquear cualquier cambio de configuración sin una tarea aceptada de Atlas dev', modulos: ['modo', 'atlas-dev'], requiere: [], pendiente: 'cubierto por tests unitarios (atlas/tests/modo.test.ts)' },
  { id: 'pasarela', capa: 'base', responsabilidad: 'Convertir los hallazgos en tareas borrador de Atlas dev, sin duplicar ni reabrir lo descartado', modulos: ['pasarela-borradores'], requiere: [], pendiente: 'cubierto por tests unitarios (atlas/tests/pasarela.test.ts)' },
  { id: 'laboratorio', capa: 'base', responsabilidad: 'Ejecutar los laboratorios sobre tareas anonimizadas y guardar sus resultados', modulos: ['laboratorio', 'ab', 'componentes', 'arquitectura', 'fichas-componentes'], requiere: 'todos', pendiente: 'es el propio motor (atlas/tests/laboratorio.test.ts)' },
  // ── Decisión ──
  { id: 'clasificador', capa: 'decision', responsabilidad: 'Dar nivel, dominio, intención y subtareas a un prompt', modulos: ['heuristica'], requiere: [], laboratorio: laboratorioClasificador },
  { id: 'delegador', capa: 'decision', responsabilidad: 'Elegir el agente de cada subtarea según el perfil y sus reglas', modulos: ['delegar', 'perfiles', 'reglas', 'perfil-texto'], requiere: ['aislamiento', 'clasificador', 'especialistas', 'limites', 'proveedores', 'rotador', 'selector'], config: { lectura: '/routing-layout' }, laboratorio: laboratorioDelegador },
  { id: 'especialistas', capa: 'decision', responsabilidad: 'Categorizar tareas con paquetes de skills complementarios a las sugerencias sueltas', modulos: ['especialistas', 'especialistas-config', 'especialistas-catalogo'], requiere: [], config: { lectura: '/especialistas/config', escritura: '/especialistas/config' }, laboratorio: laboratorioEspecialistas },
  { id: 'dosificador', capa: 'decision', responsabilidad: 'Decidir cuándo, dónde y con qué agente se lanza cada tarea para llegar a la renovación del plan con margen', modulos: ['dosificador', 'dosificador-config', 'dosificador-cuota', 'dosificador-sim'], requiere: [], config: { lectura: '/dosificador/config', escritura: '/dosificador/config' }, laboratorio: laboratorioDosificador },
  { id: 'selector', capa: 'decision', responsabilidad: 'Elegir las skills que necesita un prompt', modulos: ['skills-seleccion'], requiere: [], laboratorio: laboratorioSelector },
  { id: 'rotador', capa: 'decision', responsabilidad: 'Dejar instaladas solo las skills que se usan y guardar el resto en el almacén', modulos: ['rotador'], requiere: [], laboratorio: laboratorioRotador },
  { id: 'tutor', capa: 'decision', responsabilidad: 'Elegir con datos de cada semana el modelo tutor de mejor relación razonamiento/precio', modulos: ['tutor'], requiere: [], laboratorio: laboratorioTutor },
  { id: 'etiquetas', capa: 'decision', responsabilidad: 'Poner la cabecera «Atlas dev · tarea <id>» y el glosario de etiquetas al agente', modulos: [], requiere: [], pendiente: 'vive en atlas-dev (server/src/tareas/formato.ts): borrador «Componente etiquetas»' },
  // ── Ejecución ──
  { id: 'proveedores', capa: 'ejecucion', responsabilidad: 'Lanzar Claude Code, Codex o Qwen y devolver su salida', modulos: ['proveedores'], requiere: [], laboratorio: laboratorioProveedores },
  { id: 'limites', capa: 'ejecucion', responsabilidad: 'Decir si Claude ha pasado su umbral de uso semanal', modulos: ['limites'], requiere: [], laboratorio: laboratorioLimites },
  { id: 'aislamiento', capa: 'ejecucion', responsabilidad: 'Trabajar cada tarea en su worktree y rama agente/<id>', modulos: ['aislar-git'], requiere: [], laboratorio: laboratorioAislamiento },
  // ── Observación ──
  { id: 'analitica', capa: 'observacion', responsabilidad: 'Contar skills recomendadas, preparadas y usadas', modulos: ['analitica', 'catalogo'], requiere: [], laboratorio: laboratorioAnalitica },
  { id: 'produccion', capa: 'observacion', responsabilidad: 'Medir acierto, re-trabajo, eficiencia y «qué mejorar»', modulos: ['produccion'], requiere: [], laboratorio: laboratorioProduccion },
  { id: 'tutoria', capa: 'observacion', responsabilidad: 'Calificar al agente local con tareas ya integradas y un tutor que no da la solución', modulos: ['tutoria', 'tutoria-nota', 'skillforge'], requiere: ['delegador', 'proveedores'], laboratorio: laboratorioTutoria },
  // ── Modificadores (familia ampliable) ──
  { id: 'curador', capa: 'modificadores', responsabilidad: 'Proponer qué skills sobran en la biblioteca con reglas inequívocas', modulos: ['curador'], requiere: [], laboratorio: laboratorioCurador },
  { id: 'comparador', capa: 'modificadores', responsabilidad: 'Comparar cada skill (y Karajan) con las mejores de su grupo', modulos: ['comparador'], requiere: ['biblioteca'], laboratorio: laboratorioComparador },
  { id: 'eficiencia', capa: 'modificadores', responsabilidad: 'Aplicar ponytail (mínimo código suficiente) a lo que se delega', modulos: ['eficiencia'], requiere: [], laboratorio: laboratorioEficiencia },
  { id: 'metodo', capa: 'modificadores', responsabilidad: 'Aplicar el método de superpowers (TDD, planes, worktrees)', modulos: ['metodo'], requiere: [], laboratorio: laboratorioMetodo },
  { id: 'prompts', capa: 'modificadores', responsabilidad: 'Optimizar el prompt que recibe el agente (karpathy-skills, dspy, promptfoo)', modulos: ['prompts'], requiere: [], laboratorio: laboratorioPrompts },
  // ── Interfaz ──
  { id: 'api', capa: 'interfaz', responsabilidad: 'Exponer Karajan a Atlas dev (rutas del paquete)', modulos: ['servidor'], requiere: 'todos', pendiente: 'cubierto por los laboratorios de cada componente' },
  { id: 'cli', capa: 'interfaz', responsabilidad: 'Manejar Karajan desde la terminal: laboratorios, gráficas y propuestas', modulos: ['cli'], requiere: [], pendiente: 'cubierto por atlas/tests/cli.test.ts' },
];

export const COMPONENTES: Componente[] = DEFINICION.map((c) => ({ ...c, familia: c.capa }));

/**
 * Flujo de datos entre componentes, para las flechas de la ventana. Solo lo que el código (o, si `previsto`, el diseño de
 * docs/laboratorio/componentes.md) respalda; `de` entrega algo a `a`. Los extremos deben ser ids de componente (lo comprueba
 * arquitectura.test.ts).
 */
export interface Enlace { de: string; a: string; etiqueta?: string; /** Aún no existe en el código: lo traerá el borrador del componente `de`. */ previsto?: boolean }
export const ENLACES: Enlace[] = [
  { de: 'clasificador', a: 'delegador', etiqueta: 'nivel, dominio, intención y subtareas' },
  { de: 'selector', a: 'delegador', etiqueta: 'skills recomendadas' },
  { de: 'especialistas', a: 'delegador', etiqueta: 'categoría, modelo y paquete opcional; conserva sugerencias' },
  { de: 'clasificador', a: 'dosificador', etiqueta: 'nivel y dominio: coste esperado de la tarea' },
  { de: 'limites', a: 'dosificador', etiqueta: '% usado y reinicio de cada ventana de cada agente' },
  { de: 'almacen', a: 'dosificador', etiqueta: 'coste real de las tareas terminadas (aprende el estimador)' },
  { de: 'dosificador', a: 'delegador', etiqueta: 'cuándo, en qué equipo y con qué agente lanzar' },
  { de: 'delegador', a: 'proveedores', etiqueta: 'agente y modelo de cada subtarea' },
  { de: 'delegador', a: 'limites', etiqueta: '¿Claude pasó su umbral semanal?' },
  { de: 'delegador', a: 'rotador', etiqueta: 'repone la skill elegida' },
  { de: 'delegador', a: 'aislamiento', etiqueta: 'worktree y rama de la tarea' },
  { de: 'aislamiento', a: 'proveedores', etiqueta: 'carpeta donde trabaja el agente' },
  { de: 'delegador', a: 'almacen', etiqueta: 'tarea, decisiones y runs' },
  { de: 'almacen', a: 'rotador', etiqueta: 'último uso de cada skill' },
  { de: 'almacen', a: 'analitica', etiqueta: 'skills recomendadas, preparadas y usadas' },
  { de: 'almacen', a: 'produccion', etiqueta: 'tareas, runs y revisiones' },
  { de: 'modo', a: 'pasarela', etiqueta: 'cambio bloqueado → borrador' },
  { de: 'laboratorio', a: 'pasarela', etiqueta: 'hallazgos → borradores' },
  { de: 'cli', a: 'api', etiqueta: 'peticiones HTTP' },
  { de: 'api', a: 'modo', etiqueta: 'guardián de las mutaciones' },
  { de: 'api', a: 'delegador', etiqueta: 'planificar y delegar' },
  { de: 'api', a: 'laboratorio', etiqueta: 'ejecutar laboratorios' },
  { de: 'biblioteca', a: 'curador', etiqueta: 'datos de las skills' },
  { de: 'tutor', a: 'tutoria', etiqueta: 'modelo tutor vigente' },
  { de: 'almacen', a: 'tutoria', etiqueta: 'tareas integradas y su commit de referencia' },
  { de: 'delegador', a: 'tutoria', etiqueta: 'misma instrucción y skills que en producción' },
  { de: 'proveedores', a: 'tutoria', etiqueta: 'ejecuta alumno y tutor' },
  { de: 'rotador', a: 'tutoria', etiqueta: 'skills instaladas del alumno' },
  // Previstos (borradores en Atlas dev, ver docs/laboratorio/componentes.md §6-7).
  { de: 'biblioteca', a: 'comparador', etiqueta: 'datos de las skills' },
  { de: 'eficiencia', a: 'delegador', etiqueta: 'modifica lo que se delega', previsto: true },
  { de: 'metodo', a: 'delegador', etiqueta: 'modifica lo que se delega', previsto: true },
  { de: 'prompts', a: 'delegador', etiqueta: 'modifica lo que se delega', previsto: true },
];

export const componente = (id: string) => COMPONENTES.find((c) => c.id === id) ?? null;
