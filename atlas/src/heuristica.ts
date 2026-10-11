import { randomBytes } from 'node:crypto';

import { formatear, redondear } from './redondeo';

/**
 * Clasificador heurístico de Karajan (puerto de `app/router.py` y de la parte determinista de `app/classifier.py`): detecta
 * dominios e intención por palabras, puntúa seis criterios, pondera la complejidad, elige nivel y modelo lógico, propone
 * skills y subtareas y decide si hace falta revisión humana. Es lo que usa Karajan en el perfil `offline` y como respaldo
 * cuando no hay LLM; aquí es el único clasificador (la clasificación con LLM necesita proveedores, ver PORTE.md).
 * La paridad con el original se comprueba contra salidas grabadas de Python (tests/paridad.test.ts).
 */
export type Nivel = 'level_1_simple' | 'level_2_moderate' | 'level_3_intermediate' | 'level_4_complex' | 'level_5_critical';
export type ModeloLogico = 'cheap_model' | 'cheap_or_medium_model' | 'medium_model' | 'strong_model' | 'strong_model_with_human_review';

export interface Criterios {
  ambiguity: number; context_required: number; reasoning_depth: number; autonomy_required: number; operational_risk: number; validation_difficulty: number;
}
export interface Subtarea {
  id: string; name: string; complexity: number; recommended_model: ModeloLogico; recommended_skill: string | null; recommended_strategy: string | null; validation: string;
}
export interface Clasificacion {
  task_id: string; original_prompt: string; domain: string[]; intent: string; criteria: Criterios; complexity_score: number; complexity_level: Nivel;
  recommended_strategy: string; recommended_model: ModeloLogico; recommended_skills: string[]; recommended_resources: unknown[]; subtasks: Subtarea[];
  requires_human_review: boolean; reason: string; validation_plan: string; classified_by: string; created_at: string;
}

export interface Politica { sensitive_domains: string[]; critical_intents: string[]; human_review_min_level: number; operational_risk_review_threshold: number }
export interface Configuracion {
  criteria_weights: Record<string, number>;
  level_thresholds: number[];
  level_to_model: Record<string, string>;
  policy: Politica;
}

/** Valores por defecto de `KarajanConfig` (`app/models.py`) que afectan a la clasificación. */
export const CONFIG_POR_DEFECTO: Configuracion = {
  criteria_weights: { ambiguity: 0.2, context_required: 0.2, reasoning_depth: 0.2, autonomy_required: 0.15, operational_risk: 0.15, validation_difficulty: 0.1 },
  level_thresholds: [1.5, 2.5, 3.5, 4.3],
  level_to_model: {
    level_1_simple: 'cheap_model', level_2_moderate: 'cheap_or_medium_model', level_3_intermediate: 'medium_model',
    level_4_complex: 'strong_model', level_5_critical: 'strong_model_with_human_review',
  },
  policy: { sensitive_domains: ['security', 'operations', 'devops'], critical_intents: ['security_architecture_review', 'security_review'], human_review_min_level: 5, operational_risk_review_threshold: 4.0 },
};

/** Mezcla lo que traiga un `active_config.json` con los valores por defecto (sin validar a fondo: lo que no encaja se ignora). */
export function configDesde(bruto: unknown): Configuracion {
  const c: Configuracion = structuredClone(CONFIG_POR_DEFECTO);
  if (!bruto || typeof bruto !== 'object') return c;
  const o = bruto as Record<string, unknown>;
  const numeros = (v: unknown): v is Record<string, number> => !!v && typeof v === 'object' && Object.values(v).every((x) => typeof x === 'number');
  if (numeros(o['criteria_weights'])) c.criteria_weights = { ...c.criteria_weights, ...o['criteria_weights'] };
  if (Array.isArray(o['level_thresholds']) && o['level_thresholds'].length === 4 && o['level_thresholds'].every((x) => typeof x === 'number')) c.level_thresholds = o['level_thresholds'] as number[];
  const mapa = o['level_to_model'];
  if (mapa && typeof mapa === 'object') for (const [k, v] of Object.entries(mapa)) if (typeof v === 'string' && k in c.level_to_model) c.level_to_model[k] = v;
  const p = o['policy'];
  if (p && typeof p === 'object') {
    const q = p as Record<string, unknown>;
    if (Array.isArray(q['sensitive_domains'])) c.policy.sensitive_domains = q['sensitive_domains'].map(String);
    if (Array.isArray(q['critical_intents'])) c.policy.critical_intents = q['critical_intents'].map(String);
    if (typeof q['human_review_min_level'] === 'number') c.policy.human_review_min_level = q['human_review_min_level'];
    if (typeof q['operational_risk_review_threshold'] === 'number') c.policy.operational_risk_review_threshold = q['operational_risk_review_threshold'];
  }
  return c;
}

const NIVELES: Nivel[] = ['level_1_simple', 'level_2_moderate', 'level_3_intermediate', 'level_4_complex', 'level_5_critical'];

const DOMINIOS: [string, string[]][] = [
  ['security', ['secret', 'token', 'credential', 'vulnerability', 'threat', 'malware', 'permission', 'auth']],
  ['devops', ['jenkins', 'ci', 'cd', 'pipeline', 'docker', 'kubernetes', 'deploy', 'release']],
  ['programming', ['code', 'bug', 'fix', 'refactor', 'api', 'backend', 'frontend', 'test', 'database']],
  ['data', ['sql', 'csv', 'etl', 'analytics', 'metric', 'dashboard', 'report']],
  ['documents', ['pdf', 'docx', 'ocr', 'contract', 'document', 'extract']],
  ['product', ['ux', 'ui', 'workflow', 'requirements', 'roadmap', 'feature']],
];

const SKILLS_POR_DOMINIO: Record<string, string[]> = {
  security: ['security-review', 'cti-analyst'],
  devops: ['repo-analyzer'],
  programming: ['repo-analyzer', 'backend-builder', 'frontend-builder'],
  data: ['repo-analyzer', 'promptfoo'],
  documents: ['repo-analyzer'],
  product: ['frontend-builder'],
  general: ['ponytail'],
};

const cuenta = (texto: string, terminos: string[]) => terminos.reduce((n, t) => n + (texto.includes(t) ? 1 : 0), 0);
const ocurrencias = (texto: string, c: string) => texto.split(c).length - 1;
const min = Math.min;

/** `re.escape` + `(?<!\w)…(?!\w)` con \w de Unicode: el término debe aparecer como palabra, no como trozo de otra. */
function contieneTermino(texto: string, termino: string): boolean {
  const esc = termino.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'u').test(texto);
}

/** `sum()` de Python ≥ 3.12 sobre floats: suma compensada de Neumaier (el resultado puede diferir en el último bit de una suma simple). */
export function sumaPython(valores: number[]): number {
  let suma = 0;
  let compensacion = 0;
  for (const x of valores) {
    const t = suma + x;
    compensacion += Math.abs(suma) >= Math.abs(x) ? (suma - t) + x : (x - t) + suma;
    suma = t;
  }
  return compensacion && Number.isFinite(compensacion) ? suma + compensacion : suma;
}

export function calcularComplejidad(c: Criterios, pesos: Record<string, number> = CONFIG_POR_DEFECTO.criteria_weights): number {
  return redondear(sumaPython(Object.entries(pesos).map(([nombre, peso]) => (c as unknown as Record<string, number>)[nombre]! * peso)), 2);
}

export function nivelPara(score: number, umbrales: number[] = CONFIG_POR_DEFECTO.level_thresholds): Nivel {
  for (let i = 0; i < umbrales.length; i++) if (score <= umbrales[i]!) return NIVELES[i]!;
  return NIVELES[NIVELES.length - 1]!;
}

export const modeloPara = (nivel: Nivel, mapa: Record<string, string> = CONFIG_POR_DEFECTO.level_to_model): ModeloLogico => mapa[nivel] as ModeloLogico;

function detectarDominios(texto: string): string[] {
  const d = DOMINIOS.filter(([, palabras]) => palabras.some((p) => contieneTermino(texto, p))).map(([n]) => n);
  return d.length ? d : ['general'];
}

function detectarIntencion(t: string): string {
  const alguna = (...ps: string[]) => ps.some((p) => t.includes(p));
  if (alguna('corrige', 'fix', 'arregla', 'debug', 'bug', 'error')) return 'diagnose_and_fix';
  if (alguna('crea', 'build', 'implement', 'desarrolla', 'añade', 'add')) return 'implement_feature';
  if (alguna('revisa', 'review', 'audita', 'analiza')) return 'analyze_or_review';
  if (alguna('resume', 'summarize', 'traduce', 'extract')) return 'transform_or_extract';
  return 'classify_and_plan';
}

const ambiguedad = (t: string, n: number) => min(5.0, (n >= 12 ? 1.0 : 2.0) + cuenta(t, ['algo', 'mejor', 'rápido', 'simple', 'varios', 'etc', 'thing', 'stuff']) * 0.7 + min(ocurrencias(t, '?'), 3) * 0.3);

function contexto(t: string, n: number): number {
  const terminos = cuenta(t, ['repo', 'varios archivos', 'base de datos', 'producción', 'logs', 'existing', 'pipeline', 'sistema', 'modulo', 'componente', 'servicio', 'microservicio', 'clase', 'interfaz']);
  const requisitos = ocurrencias(t, ',') + ocurrencias(t, ';');
  const largo = n > 80 ? 1.5 : n > 45 ? 0.8 : 0.0;
  return min(5.0, 1.0 + terminos * 0.8 + largo + min(1.0, requisitos * 0.2));
}

const razonamiento = (t: string, n: number) => min(5.0, 1.0 + cuenta(t, [
  'arquitectura', 'orquestador', 'debug', 'optimiza', 'decide', 'riesgo', 'multi', 'workflow', 'cache', 'lru', 'fifo', 'queue', 'árbol', 'tree', 'graph', 'concurrent', 'async', 'ttl',
  'patron', 'pattern', 'decorator', 'memoiz', 'algoritmo', 'algorithm', 'complejidad', 'rendimiento', 'performance', 'escalab', 'distribuido',
]) * 0.65 + (n > 80 ? 1.0 : 0.0));

const autonomia = (t: string) => min(5.0, 1.0 + cuenta(t, ['implementa', 'desarrolla', 'end to end', 'automatiza', 'ejecuta', 'deploy', 'construye', 'diseña', 'crea', 'build', 'create', 'generate', 'escribe', 'develop']) * 0.75);

const riesgo = (t: string, dominios: string[]) => min(5.0, 0.8 + cuenta(t, ['producción', 'deploy', 'delete', 'borrar', 'secret', 'token', 'dinero', 'legal', 'seguridad']) * 0.8 + (dominios.includes('security') || dominios.includes('devops') ? 1.0 : 0.0));

const validacion = (t: string, dominios: string[]) => min(5.0, 1.0 + cuenta(t, ['test', 'ci', 'pipeline', 'visual', 'dashboard', 'api', 'database', 'sqlite', 'unitario', 'integracion', 'cobertura', 'coverage', 'assert', 'mock', 'fixture']) * 0.45
  + (['programming', 'devops', 'data'].some((d) => dominios.includes(d)) ? 0.8 : 0.0));

function estrategia(n: Nivel): string {
  if (n === 'level_1_simple' || n === 'level_2_moderate') return 'single_model_execution';
  if (n === 'level_3_intermediate') return 'bounded_analysis_then_execute';
  if (n === 'level_4_complex') return 'divide_and_delegate';
  return 'divide_delegate_and_require_human_review';
}

function skillsRecomendadas(dominios: string[], intencion: string, nivel: Nivel): string[] {
  const skills: string[] = [];
  for (const d of dominios) for (const s of SKILLS_POR_DOMINIO[d] ?? []) if (!skills.includes(s)) skills.push(s);
  if ((intencion === 'diagnose_and_fix' || intencion === 'analyze_or_review') && !skills.includes('repo-analyzer')) skills.unshift('repo-analyzer');
  if (nivel === 'level_5_critical' && !skills.includes('security-review')) skills.push('security-review');
  if (!skills.includes('ponytail')) skills.push('ponytail');
  return skills;
}

function subtareas(intencion: string, dominios: string[], nivel: Nivel, mapa: Record<string, string>, estrat: string): Subtarea[] {
  let nombres: string[];
  if (nivel === 'level_1_simple' || nivel === 'level_2_moderate') nombres = ['Resolver tarea principal', 'Validar salida'];
  else if (intencion === 'diagnose_and_fix') nombres = ['Localizar causa probable', 'Proponer corrección acotada', 'Validar regresiones'];
  else if (intencion === 'implement_feature') nombres = ['Diseñar contrato mínimo', 'Implementar flujo principal', 'Persistir auditoría', 'Validar comportamiento'];
  else nombres = ['Analizar intención y contexto', 'Dividir trabajo', 'Ejecutar subtareas delimitadas', 'Validar coherencia final'];
  const numero = NIVELES.indexOf(nivel) + 1;
  const pista = (SKILLS_POR_DOMINIO[dominios[0]!] ?? ['ponytail'])[0]!;
  return nombres.map((nombre, i) => {
    const indice = i + 1;
    // La última subtarea lleva el peso de validación más alto; las demás, un nivel menos.
    const n = Math.min(5, Math.max(1, numero - (indice === nombres.length ? 0 : 1)));
    return {
      id: `sub_${String(indice).padStart(3, '0')}`, name: nombre, complexity: n, recommended_model: modeloPara(NIVELES[n - 1]!, mapa),
      recommended_skill: nombre.toLowerCase().startsWith('validar') ? 'security-review' : pista, recommended_strategy: estrat, validation: `Comprobar evidencia para: ${nombre.toLowerCase()}`,
    };
  });
}

export function requiereRevision(nivel: Nivel, c: Criterios, dominios: string[], intencion: string, config: Configuracion | null): boolean {
  if (!config) return nivel === 'level_5_critical' || c.operational_risk >= 4;
  const p = config.policy;
  return NIVELES.indexOf(nivel) + 1 >= p.human_review_min_level || c.operational_risk >= p.operational_risk_review_threshold
    || dominios.some((d) => p.sensitive_domains.includes(d)) || p.critical_intents.includes(intencion);
}

function razon(dominios: string[], intencion: string, c: Criterios, nivel: Nivel): string {
  let mejor: [string, number] = ['', -Infinity];
  for (const par of Object.entries(c) as [string, number][]) if (par[1] > mejor[1]) mejor = par;
  return `Detected ${intencion} across ${dominios.join(', ')}. Highest driver is ${mejor[0]}=${formatear(mejor[1], 1)}, producing ${nivel}.`;
}

function planValidacion(nivel: Nivel, dominios: string[]): string {
  if (nivel === 'level_4_complex' || nivel === 'level_5_critical') return 'Run automated checks, inspect audit trail, and require final parent-model consistency review.';
  if (dominios.includes('programming')) return 'Run focused unit/API checks and confirm no contract regressions.';
  return 'Confirm output matches the original request and record validation evidence.';
}

/** `classify_prompt(prompt, config)`. Con `config = null` reproduce el comportamiento sin configuración de Python. */
export function clasificar(prompt: string, config: Configuracion | null = CONFIG_POR_DEFECTO, ahora: Date = new Date()): Clasificacion {
  const t = prompt.toLowerCase();
  const n = (t.match(/[a-zA-Z0-9_áéíóúñüÁÉÍÓÚÑÜ-]+/g) ?? []).length;
  const dominios = detectarDominios(t);
  const intencion = detectarIntencion(t);
  const criterios: Criterios = {
    ambiguity: ambiguedad(t, n), context_required: contexto(t, n), reasoning_depth: razonamiento(t, n), autonomy_required: autonomia(t),
    operational_risk: riesgo(t, dominios), validation_difficulty: validacion(t, dominios),
  };
  const score = calcularComplejidad(criterios, config?.criteria_weights);
  const nivel = nivelPara(score, config?.level_thresholds);
  const mapa = config?.level_to_model ?? CONFIG_POR_DEFECTO.level_to_model;
  const estrat = estrategia(nivel);
  return {
    task_id: `tsk_${randomBytes(6).toString('hex')}`, original_prompt: prompt, domain: dominios, intent: intencion, criteria: criterios,
    complexity_score: score, complexity_level: nivel, recommended_strategy: estrat, recommended_model: modeloPara(nivel, mapa),
    recommended_skills: skillsRecomendadas(dominios, intencion, nivel), recommended_resources: [], subtasks: subtareas(intencion, dominios, nivel, mapa, estrat),
    requires_human_review: requiereRevision(nivel, criterios, dominios, intencion, config), reason: razon(dominios, intencion, criterios, nivel),
    validation_plan: planValidacion(nivel, dominios), classified_by: 'heuristic', created_at: ahora.toISOString(),
  };
}
