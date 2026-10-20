import type { Laboratorio } from './laboratorio';
import { laboratorioBiblioteca } from './lab/biblioteca.lab';
import { laboratorioClasificador } from './lab/clasificador.lab';
import { laboratorioDelegador } from './lab/delegador.lab';
import { laboratorioSelector } from './lab/selector.lab';

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

export interface Componente {
  id: string; capa: Capa; responsabilidad: string;
  /** Módulos de `src/` (sin extensión) que son de este componente. */
  modulos: string[];
  laboratorio?: Laboratorio<any>;
  /** Si aún no tiene laboratorio (o no existe todavía): qué lo trae. */
  pendiente?: string;
}

export const COMPONENTES: Componente[] = [
  // ── Base ──
  { id: 'almacen', capa: 'base', responsabilidad: 'Guardar y leer el registro de tareas, decisiones, runs y revisiones', modulos: ['almacen', 'redondeo'], pendiente: 'cubierto por la paridad con Python; laboratorio en el borrador «Laboratorios de ejecución y observación»' },
  { id: 'biblioteca', capa: 'base', responsabilidad: 'Dar la ficha de una skill (estrellas, repo, taxonomía) desde resources.db, en solo lectura', modulos: ['biblioteca'], laboratorio: laboratorioBiblioteca },
  { id: 'modo', capa: 'base', responsabilidad: 'Bloquear cualquier cambio de configuración sin una tarea aceptada de Atlas dev', modulos: ['modo', 'atlas-dev'], pendiente: 'cubierto por tests unitarios (atlas/tests/modo.test.ts)' },
  { id: 'pasarela', capa: 'base', responsabilidad: 'Convertir los hallazgos en tareas borrador de Atlas dev, sin duplicar ni reabrir lo descartado', modulos: ['pasarela-borradores'], pendiente: 'cubierto por tests unitarios (atlas/tests/pasarela.test.ts)' },
  { id: 'laboratorio', capa: 'base', responsabilidad: 'Ejecutar los laboratorios sobre tareas anonimizadas y guardar sus resultados', modulos: ['laboratorio', 'componentes'], pendiente: 'es el propio motor (atlas/tests/laboratorio.test.ts)' },
  // ── Decisión ──
  { id: 'clasificador', capa: 'decision', responsabilidad: 'Dar nivel, dominio, intención y subtareas a un prompt', modulos: ['heuristica'], laboratorio: laboratorioClasificador },
  { id: 'delegador', capa: 'decision', responsabilidad: 'Elegir el agente de cada subtarea según el perfil y sus reglas', modulos: ['delegar', 'perfiles', 'reglas', 'perfil-texto'], laboratorio: laboratorioDelegador },
  { id: 'selector', capa: 'decision', responsabilidad: 'Elegir las skills que necesita un prompt', modulos: ['skills-seleccion'], laboratorio: laboratorioSelector },
  { id: 'rotador', capa: 'decision', responsabilidad: 'Dejar instaladas solo las skills que se usan y guardar el resto en el almacén', modulos: ['rotador'], pendiente: 'borrador «Laboratorio del rotador»' },
  { id: 'etiquetas', capa: 'decision', responsabilidad: 'Poner la cabecera «Atlas dev · tarea <id>» y el glosario de etiquetas al agente', modulos: [], pendiente: 'vive en atlas-dev (server/src/tareas/formato.ts): borrador «Componente etiquetas»' },
  // ── Ejecución ──
  { id: 'proveedores', capa: 'ejecucion', responsabilidad: 'Lanzar Claude Code, Codex o Qwen y devolver su salida', modulos: ['proveedores'], pendiente: 'borrador «Laboratorios de ejecución y observación»' },
  { id: 'limites', capa: 'ejecucion', responsabilidad: 'Decir si Claude ha pasado su umbral de uso semanal', modulos: ['limites'], pendiente: 'borrador «Laboratorios de ejecución y observación»' },
  { id: 'aislamiento', capa: 'ejecucion', responsabilidad: 'Trabajar cada tarea en su worktree y rama agente/<id>', modulos: ['aislar-git'], pendiente: 'borrador «Laboratorios de ejecución y observación»' },
  // ── Observación ──
  { id: 'analitica', capa: 'observacion', responsabilidad: 'Contar skills recomendadas, preparadas y usadas', modulos: ['analitica', 'catalogo'], pendiente: 'borrador «Laboratorios de ejecución y observación»' },
  { id: 'produccion', capa: 'observacion', responsabilidad: 'Medir acierto, re-trabajo, eficiencia y «qué mejorar»', modulos: ['produccion'], pendiente: 'borrador «Laboratorios de ejecución y observación»' },
  // ── Modificadores (familia ampliable) ──
  { id: 'curador', capa: 'modificadores', responsabilidad: 'Proponer qué skills sobran en la biblioteca con reglas inequívocas', modulos: [], pendiente: 'borrador «Componente curador»' },
  { id: 'comparador', capa: 'modificadores', responsabilidad: 'Comparar cada skill (y Karajan) con las mejores de su grupo', modulos: [], pendiente: 'borrador «Componente comparador»' },
  { id: 'eficiencia', capa: 'modificadores', responsabilidad: 'Aplicar ponytail (mínimo código suficiente) a lo que se delega', modulos: [], pendiente: 'borrador «Familia de modificadores»' },
  { id: 'metodo', capa: 'modificadores', responsabilidad: 'Aplicar el método de superpowers (TDD, planes, worktrees)', modulos: [], pendiente: 'borrador «Familia de modificadores»' },
  { id: 'prompts', capa: 'modificadores', responsabilidad: 'Optimizar el prompt que recibe el agente (karpathy-skills, dspy, promptfoo)', modulos: [], pendiente: 'borrador «Familia de modificadores»' },
  // ── Interfaz ──
  { id: 'api', capa: 'interfaz', responsabilidad: 'Exponer Karajan a Atlas dev (rutas del paquete)', modulos: ['servidor'], pendiente: 'cubierto por los laboratorios de cada componente' },
  { id: 'cli', capa: 'interfaz', responsabilidad: 'Manejar Karajan desde la terminal: laboratorios, gráficas y propuestas', modulos: ['cli'], pendiente: 'cubierto por atlas/tests/cli.test.ts' },
];

export const componente = (id: string) => COMPONENTES.find((c) => c.id === id) ?? null;
