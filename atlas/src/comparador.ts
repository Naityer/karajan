import { estrellasPropias, type Biblioteca, type FichaRecurso } from './biblioteca';

/**
 * Comparador: pone cada skill del equipo, y al propio Karajan, junto a las mejores de su grupo de la taxonomía de la biblioteca,
 * para saber su valor real y qué funcionalidades nos faltan. Solo cuentan las ESTRELLAS PROPIAS (nunca las heredadas de la
 * colección que recoge a la skill) y un grupo solo se compara con una muestra mínima de recursos con estrellas propias; sin
 * dato o con muestra corta se dice «sin dato» y no se puntúa.
 *
 * «Funcionalidad» aquí es una palabra clave DECLARADA (etiquetas y capacidades de la ficha; los casos de uso de la ingesta son demasiado gruesos) que ofrecen los pares y
 * no la skill: no se infiere nada más. Solo lee la biblioteca; no escribe ni propone (eso lo hace el laboratorio).
 */
export const MUESTRA_MINIMA_GRUPO = 5;
/** Cuántos pares mejor posicionados se muestran y se usan para buscar funcionalidades y pruebas. */
export const TOP_PARES = 5;
/** Una funcionalidad solo cuenta si la ofrecen al menos tantos de los pares top. */
export const MIN_PARES_FUNCIONALIDAD = 2;
/** El grupo con el que se compara a Karajan: «Orquestación y contexto». */
export const GRUPO_KARAJAN = 'rgrp_agents_orchestration';

export interface Par { nombre: string; estrellas: number; repo_url: string | null }
export interface Faltante { funcionalidad: string; pares: string[] }
export type EstadoComparacion = 'comparada' | 'sin-ficha' | 'sin-grupo' | 'sin-dato' | 'grupo-corto';
export interface Comparacion {
  sujeto: string; tipo: 'skill' | 'karajan'; estado: EstadoComparacion; motivo: string;
  grupo: string | null; grupoNombre: string | null;
  /** Estrellas PROPIAS del sujeto (null: sin dato). */
  estrellas: number | null;
  /** Posición (1 = la más estrellada) y percentil 0-100 entre los recursos del grupo con estrellas propias; null sin dato o con muestra corta. */
  posicion: number | null; percentil: number | null;
  /** Recursos del grupo con estrellas propias (sin contar al sujeto). */
  conDato: number;
  mejores: Par[]; faltan: Faltante[];
}

/** Lo que Karajan sabe de sí mismo: sus componentes y qué tipos de escenario tiene cada laboratorio (viene de `componentes.ts`). */
export interface CapacidadKarajan { id: string; responsabilidad: string; pruebas: string[] }

/** Palabras clave (en inglés, como las de la taxonomía) con las que declaramos lo que ofrece cada componente de Karajan. */
export const CLAVES_KARAJAN: Record<string, string[]> = {
  clasificador: ['classification', 'task-classification'],
  delegador: ['delegation', 'agent-orchestration', 'orchestration', 'multi-agent', 'task-routing', 'routing'],
  selector: ['skill-selection', 'skills', 'recommendation'],
  rotador: ['skill-management', 'context-management'],
  proveedores: ['claude-code', 'codex', 'multi-agent', 'cli'],
  aislamiento: ['worktree', 'git-worktree', 'isolation'],
  almacen: ['task-logging', 'logging'],
  analitica: ['analytics'], produccion: ['analytics', 'observability'],
  biblioteca: ['skill-catalog', 'catalog'],
  modo: ['human-approval', 'human-in-the-loop'], pasarela: ['human-approval', 'human-in-the-loop'],
  laboratorio: ['evaluation'],
  api: ['api'], cli: ['cli'],
};

/** Pruebas de ejecución real con feedback humano que buscamos en los pares. `cubre`: tipo de escenario de Karajan que ya la tiene. */
export interface PruebaReal { id: string; nombre: string; patron: RegExp; cubre: string | null; criterio: string }
export const PRUEBAS_REALES: PruebaReal[] = [
  { id: 'evals', nombre: 'evals sobre ejecuciones reales', patron: /\bevals?\b|\bevaluations?\b|llm-as-a-judge|llm judge/i, cubre: null, criterio: 'Un conjunto fijo de casos reales anonimizados, con la respuesta que dio la persona como verdad, puntuado con una métrica y su IC95.' },
  { id: 'benchmarks', nombre: 'benchmarks repetibles', patron: /\bbenchmarks?\b/i, cubre: null, criterio: 'Una batería versionada que se repite con cada cambio de reglas o pesos y deja su serie en el historial del laboratorio.' },
  { id: 'ab', nombre: 'pruebas A/B', patron: /\ba\/b\b|\bab[- ]tests?\b|\bsplit[- ]tests?\b/i, cubre: null, criterio: 'Dos variantes (actual y propuesta) sobre las mismas tareas reproducidas, a ciegas, y solo se propone la nueva si gana en datos no vistos.' },
  { id: 'feedback-humano', nombre: 'feedback humano explícito', patron: /human[- ](feedback|in[- ]the[- ]loop|review|evaluation|annotation)|\brlhf\b|\bannotations?\b/i, cubre: 'feedback', criterio: 'La persona confirma o corrige (sí/no) lo que Karajan propuso y esa respuesta alimenta la métrica del escenario.' },
  { id: 'preferencia', nombre: 'comparación por preferencia', patron: /\bpreference\b|\bpairwise\b|side[- ]by[- ]side|\barena\b/i, cubre: 'replay', criterio: 'Se enfrentan dos salidas para la misma tarea y la persona elige; se mide con la proporción de victorias y su IC95.' },
  { id: 'regresion-prompts', nombre: 'tests de regresión de prompts', patron: /regression test|prompt[- ]tests?|prompt regression/i, cubre: null, criterio: 'Cada prompt que falló alguna vez queda como caso fijo y la prueba falla si vuelve a clasificarse o delegarse mal.' },
];

export interface IndicioPrueba { par: string; estrellas: number; indicio: string }
export interface PruebaHallada { prueba: string; nombre: string; criterio: string; pares: IndicioPrueba[] }

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
/** Raíz tosca para que «testing» y «tests» se vean como lo mismo; las palabras cortas se dejan tal cual. */
const raiz = (p: string) => (p.length >= 5 ? p.replace(/(ing|es|s)$/, '') : p);
const palabras = (s: string) => new Set((norm(s).match(/[a-z0-9]+/g) ?? []).map(raiz));
/** Una etiqueta que declara más de esta fracción de la biblioteca (p. ej. «testing» en el 80 %) es de la ingesta, no de la skill: no cuenta como funcionalidad. */
export const FRECUENCIA_MAXIMA = 0.25;
/** Etiquetas demasiado genéricas para llamarlas funcionalidad. */
const GENERICAS = new Set(['skill', 'skills', 'agent-skill', 'agent skill', 'library', 'claude', 'claude-code', 'llm', 'anthropic', 'productivity', 'developer-tools', 'software-development', 'cli', 'api', 'mcp', 'python', 'typescript', 'javascript']);

interface Propio { claves: Set<string>; palabras: Set<string> }
const propioDe = (f: FichaRecurso | null, extra = '', claves: string[] = []): Propio => ({
  claves: new Set([...(f?.etiquetas ?? []), ...(f?.capacidades ?? []), ...(f?.usos ?? []), ...claves].map(norm)),
  palabras: palabras([f?.descripcion ?? '', extra, ...claves, ...(f?.etiquetas ?? []), ...(f?.capacidades ?? [])].join(' ')),
});
const ofrece = (p: Propio, termino: string) => {
  const t = norm(termino);
  if (p.claves.has(t)) return true;
  const ps = [...palabras(t)];
  return ps.length > 0 && ps.every((x) => p.palabras.has(x));
};

const aPar = (f: FichaRecurso): Par => ({ nombre: f.nombre, estrellas: estrellasPropias(f)!, repo_url: f.repo_url });
/** Los recursos de un grupo con estrellas propias, de más a menos estrellas. */
export function paresConDato(bib: Biblioteca, grupo: string, excluir: string[] = []): FichaRecurso[] {
  const fuera = new Set(excluir.map(norm));
  return bib.listarGrupo(grupo).filter((f) => estrellasPropias(f) !== null && !fuera.has(norm(f.nombre)) && !fuera.has(norm(f.slug)))
    .sort((a, b) => estrellasPropias(b)! - estrellasPropias(a)! || a.nombre.localeCompare(b.nombre));
}

/** Las etiquetas demasiado comunes de la biblioteca, calculadas una vez por biblioteca. */
const cacheComunes = new WeakMap<Biblioteca, Set<string>>();
const comunesDe = (bib: Biblioteca): Set<string> => {
  let c = cacheComunes.get(bib);
  if (!c) cacheComunes.set(bib, (c = new Set([...bib.frecuenciasTerminos()].filter(([, f]) => f > FRECUENCIA_MAXIMA).map(([t]) => t))));
  return c;
};

/** Funcionalidades declaradas por al menos `MIN_PARES_FUNCIONALIDAD` de los pares que el sujeto no ofrece. */
export function funcionalidadesQueFaltan(pares: FichaRecurso[], propio: Propio, comunes: ReadonlySet<string> = new Set()): Faltante[] {
  const cuenta = new Map<string, Set<string>>();
  for (const par of pares) {
    for (const t of new Set([...par.etiquetas, ...par.capacidades].map((x) => x.trim().toLowerCase()))) {
      if (t.length < 3 || GENERICAS.has(t) || comunes.has(t) || ofrece(propio, t)) continue;
      cuenta.set(t, (cuenta.get(t) ?? new Set()).add(par.nombre));
    }
  }
  return [...cuenta].filter(([, ps]) => ps.size >= MIN_PARES_FUNCIONALIDAD).map(([funcionalidad, ps]) => ({ funcionalidad, pares: [...ps] }))
    .sort((a, b) => b.pares.length - a.pares.length || a.funcionalidad.localeCompare(b.funcionalidad)).slice(0, 12);
}

/** Pruebas de ejecución real con feedback humano que declaran los pares (por palabras clave de su ficha). */
export function pruebasDe(pares: FichaRecurso[]): PruebaHallada[] {
  const r: PruebaHallada[] = [];
  for (const p of PRUEBAS_REALES) {
    const pares_ = pares.flatMap((f): IndicioPrueba[] => {
      const texto = [f.descripcion, ...f.etiquetas, ...f.capacidades, ...f.usos].join(' · ');
      const m = p.patron.exec(texto);
      if (!m) return [];
      const i = Math.max(0, m.index - 40);
      return [{ par: f.nombre, estrellas: estrellasPropias(f)!, indicio: `…${texto.slice(i, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim()}…` }];
    });
    if (pares_.length) r.push({ prueba: p.id, nombre: p.nombre, criterio: p.criterio, pares: pares_.sort((a, b) => b.estrellas - a.estrellas) });
  }
  return r;
}

/** Los tipos de escenario de los laboratorios de Karajan → qué pruebas de `PRUEBAS_REALES` ya tiene. */
export const pruebasCubiertas = (caps: CapacidadKarajan[]): Set<string> => {
  const tipos = new Set(caps.flatMap((c) => c.pruebas));
  return new Set(PRUEBAS_REALES.filter((p) => p.cubre && tipos.has(p.cubre)).map((p) => p.id));
};

function comparar(bib: Biblioteca, sujeto: string, tipo: Comparacion['tipo'], f: FichaRecurso | null, propio: Propio): Comparacion {
  const base: Comparacion = { sujeto, tipo, estado: 'comparada', motivo: '', grupo: f?.grupo ?? null, grupoNombre: null, estrellas: f ? estrellasPropias(f) : null, posicion: null, percentil: null, conDato: 0, mejores: [], faltan: [] };
  if (!f) return { ...base, estado: 'sin-ficha', motivo: 'No está en la biblioteca.' };
  if (!f.grupo) return { ...base, estado: 'sin-grupo', motivo: 'La ficha no tiene grupo de la taxonomía.' };
  const pares = paresConDato(bib, f.grupo, [f.nombre, f.slug]);
  const completo = { ...base, grupoNombre: bib.nombreGrupo(f.grupo), conDato: pares.length, mejores: pares.slice(0, TOP_PARES).map(aPar) };
  const n = pares.length + (base.estrellas !== null ? 1 : 0);
  if (n < MUESTRA_MINIMA_GRUPO) return { ...completo, estado: 'grupo-corto', motivo: `Solo ${n} recursos del grupo tienen estrellas propias (mínimo ${MUESTRA_MINIMA_GRUPO}): no se compara.` };
  // Una skill sin estrellas propias no se compara (salvo Karajan, que es local y no las tiene): sus «funcionalidades que faltan» serían las de todo el grupo.
  const faltan = base.estrellas === null && tipo !== 'karajan' ? [] : funcionalidadesQueFaltan(pares.slice(0, TOP_PARES), propio, comunesDe(bib));
  if (base.estrellas === null) return { ...completo, estado: 'sin-dato', faltan, motivo: f.heredadas ? 'Sus estrellas son las de la colección que la recoge: sin estrellas propias no se puntúa.' : 'Sin estrellas propias: no se puntúa.' };
  const menores = pares.filter((p) => estrellasPropias(p)! < base.estrellas!).length;
  const iguales = pares.filter((p) => estrellasPropias(p) === base.estrellas).length + 1;
  return { ...completo, faltan, motivo: '', posicion: 1 + pares.filter((p) => estrellasPropias(p)! > base.estrellas!).length, percentil: Math.round(((menores + iguales / 2) / n) * 100) };
}

/** Una skill del equipo frente a las mejores de su grupo. `descripcion` es la de su SKILL.md local (más fiable que la de la ficha). */
export function compararSkill(bib: Biblioteca, skill: { name: string; description?: string }): Comparacion {
  const f = bib.fichaDe(skill.name);
  return comparar(bib, skill.name, 'skill', f, propioDe(f, skill.description ?? ''));
}

export const compararEquipo = (bib: Biblioteca, skills: { name: string; description?: string }[]): Comparacion[] => skills.map((s) => compararSkill(bib, s));

/** Karajan frente a sus pares de «Orquestación y contexto», con las capacidades declaradas de `CLAVES_KARAJAN` (solo las de los componentes que existen). */
export function compararKarajan(bib: Biblioteca, caps: CapacidadKarajan[]): Comparacion {
  const claves = [...new Set(caps.flatMap((c) => CLAVES_KARAJAN[c.id] ?? []))];
  const propio = propioDe(null, caps.map((c) => c.responsabilidad).join(' '), claves);
  // Karajan está en la biblioteca como skill local, sin estrellas propias: «sin dato», pero sí se compara su oferta con la de los pares.
  const stub: FichaRecurso = { nombre: 'karajan', slug: 'karajan', tipo: 'skill', descripcion: '', estrellas: null, heredadas: false, repo_url: null, grupo: null, capacidades: [], etiquetas: [], usos: [] };
  return comparar(bib, 'karajan', 'karajan', { ...stub, ...(bib.fichaDe('karajan') ?? {}), grupo: GRUPO_KARAJAN }, propio);
}

/** Las pruebas con feedback humano que declaran los mejores pares (con estrellas propias, sin Karajan) de varios grupos; cada par cuenta una vez. */
export function pruebasEnGrupos(bib: Biblioteca, grupos: string[]): PruebaHallada[] {
  const vistos = new Map<string, FichaRecurso>();
  for (const g of new Set(grupos)) for (const f of paresConDato(bib, g, ['karajan']).slice(0, TOP_PARES)) vistos.set(f.slug, f);
  return pruebasDe([...vistos.values()]);
}
