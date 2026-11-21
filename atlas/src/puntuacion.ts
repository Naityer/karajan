import { contiene, detectarAreas, type Entidad } from './reglas';

/**
 * Puntuación continua de agentes: reparte por `complexity_score` (0–5) y fichas de aptitud, no por 5 niveles. Espejo de
 * `app/routing/puntuacion.py` (mismas fórmulas y mismas áreas finas):
 *
 *   score = w_complejidad·ajuste + w_dominio·afinidad_dominio + w_criterios·afinidad_criterios
 *           + w_fiabilidad·fiabilidad − w_coste·coste·(1 − riesgo)      (0–100; gana la mayor)
 *
 * Las reglas del perfil quedan como vetos/forzados y se evalúan antes. Una entidad con `duracion_max_min` se descarta si la
 * duración estimada de la tarea la supera.
 */
export interface Aptitud {
  rango_complejidad: [number, number]; optimo: number; afinidad_dominio: Record<string, number>; afinidad_criterio: Record<string, number>;
  coste_relativo: number; duracion_max_min: number | null; fiabilidad_prior: number; medido: boolean;
}
export interface Scoring {
  w_complejidad: number; w_dominio: number; w_criterios: number; w_coste: number; w_fiabilidad: number;
  min_base: number; min_por_complejidad: number; min_por_contexto: number;
}
export const SCORING_POR_DEFECTO: Scoring = { w_complejidad: 35, w_dominio: 25, w_criterios: 15, w_coste: 15, w_fiabilidad: 10, min_base: 1, min_por_complejidad: 3, min_por_contexto: 2 };

export const AREAS_EXTRA: Record<string, string[]> = {
  grafico: ['vídeo', 'video', 'imagen', 'imágenes', 'gráfico', 'gráficos', 'ilustración', 'animación', 'cartel', 'logo'],
  redaccion: ['redacta', 'redactar', 'redacción', 'texto', 'artículo', 'resumen', 'correo', 'carta', 'explica', 'explicación'],
  academico: ['académico', 'académica', 'asignatura', 'estudio', 'estudiar', 'examen', 'apuntes', 'trabajo académico', 'tfg', 'tfm'],
  planificacion: ['planifica', 'planificar', 'planificación', 'plan de', 'roadmap', 'estrategia', 'organiza', 'descompón'],
};
export const CRITERIOS = ['ambiguity', 'context_required', 'reasoning_depth', 'autonomy_required', 'operational_risk', 'validation_difficulty'] as const;
const NEUTRAL = 0.4;
const NEUTRAL_CRITERIO = 0.5;

export interface TareaPuntuable { complejidad: number; criterios: Record<string, number>; areas: string[] }
export type EntidadConFicha = Entidad & { aptitud?: Aptitud | null; model?: string | null };

export function areasDeTarea(prompt: string, dominios: string[]): string[] {
  const texto = prompt.toLowerCase();
  const areas = [...detectarAreas(prompt)];
  for (const [a, palabras] of Object.entries(AREAS_EXTRA)) if (!areas.includes(a) && palabras.some((p) => contiene(texto, p))) areas.push(a);
  for (const d of dominios) if (d !== 'general' && !areas.includes(d)) areas.push(d);
  return areas;
}

export function tareaDesdeClasificacion(score: number, criterios: Record<string, number>, prompt: string, dominios: string[], desplazamiento = 0): TareaPuntuable {
  return {
    complejidad: Math.min(5, Math.max(0, score + desplazamiento)),
    criterios: Object.fromEntries(CRITERIOS.map((k) => [k, Number(criterios[k] ?? 0)])),
    areas: areasDeTarea(prompt, dominios),
  };
}

const riesgo = (t: TareaPuntuable) => Math.min(1, Math.max(0, (t.criterios['operational_risk'] ?? 0) / 5));
export const duracionEstimadaMin = (t: TareaPuntuable, c: Scoring) => c.min_base + c.min_por_complejidad * t.complejidad + c.min_por_contexto * (t.criterios['context_required'] ?? 0);

export function ajusteComplejidad(a: Aptitud, complejidad: number): number {
  const [low, high] = a.rango_complejidad;
  if (complejidad < low || complejidad > high) {
    const fuera = complejidad < low ? low - complejidad : complejidad - high;
    return Math.max(0, 0.3 - 0.3 * fuera);
  }
  const lado = complejidad <= a.optimo ? a.optimo - low : high - a.optimo;
  return lado <= 0 ? 1 : 1 - (0.6 * Math.abs(complejidad - a.optimo)) / lado;
}

export function afinidadDominio(a: Aptitud, areas: string[]): number {
  if (!areas.length) return a.afinidad_dominio['general'] ?? NEUTRAL;
  return areas.reduce((s, x) => s + (a.afinidad_dominio[x] ?? NEUTRAL), 0) / areas.length;
}

export function afinidadCriterios(a: Aptitud, criterios: Record<string, number>): number {
  const pesos = Object.entries(criterios).filter(([, v]) => v > 0).map(([k, v]) => [k, v / 5] as const);
  const total = pesos.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return NEUTRAL_CRITERIO;
  return pesos.reduce((s, [k, w]) => s + w * (a.afinidad_criterio[k] ?? NEUTRAL_CRITERIO), 0) / total;
}

const redondear2 = (n: number) => Math.round(n * 100) / 100;

export function puntuar(e: EntidadConFicha, t: TareaPuntuable, c: Scoring): number {
  const a = e.aptitud;
  if (!a) return 0;
  const bruto = c.w_complejidad * ajusteComplejidad(a, t.complejidad) + c.w_dominio * afinidadDominio(a, t.areas) + c.w_criterios * afinidadCriterios(a, t.criterios)
    + c.w_fiabilidad * a.fiabilidad_prior - c.w_coste * a.coste_relativo * (1 - riesgo(t));
  return redondear2(Math.min(100, Math.max(0, bruto)));
}

/** Entidades con ficha de mayor a menor puntuación (desempate: id), sin las vetadas por duración. */
export function ranking(entidades: EntidadConFicha[], t: TareaPuntuable, cfg: Scoring | null | undefined): { entidad: EntidadConFicha; puntos: number }[] {
  const c = { ...SCORING_POR_DEFECTO, ...(cfg ?? {}) };
  const minutos = duracionEstimadaMin(t, c);
  return entidades
    .filter((e) => e.aptitud && e.provider && (e.aptitud.duracion_max_min === null || e.aptitud.duracion_max_min === undefined || minutos <= e.aptitud.duracion_max_min))
    .map((entidad) => ({ entidad, puntos: puntuar(entidad, t, c) }))
    .sort((x, y) => y.puntos - x.puntos || (x.entidad.id < y.entidad.id ? -1 : 1));
}
