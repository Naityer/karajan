import type { Perfil } from './reglas';
import { areasDeTarea, type Aptitud } from './puntuacion';

/**
 * Evolución de perfiles de enrutado, al modo de un algoritmo genético y siempre basada en métricas. Espejo de
 * `app/routing/evolucion.py` (mismos umbrales, mismos operadores y el mismo generador congruencial).
 *
 * Fitness: tasa de éxito (con intervalo de Wilson) de cada entidad por área y por banda de `complexity_score` (pasos de 0.5), leída de
 * `runs` ⨝ `tasks`; con menos de `MIN_MUESTRAS` ejecuciones no hay evidencia y no se muta nada. Mutación: un solo gen y solo ante una
 * necesidad demostrada. Cruce: cada entidad hereda la ficha del padre con mejor evidencia propia. Nada se activa solo: los hijos son
 * perfiles nuevos con linaje y `default_profile_id` no se toca.
 */
export const MIN_MUESTRAS = 10;
export const EXITO_OBJETIVO = 0.75;
export const EXITO_SOBRESALIENTE = 0.9;
export const MAX_HIJOS = 4;
const PASO_BASE = 0.1;
const PASO_ALEATORIO = 0.1;

export interface Muestra { profile_id: string | null; clave: [string, string]; complejidad: number; areas: string[]; ok: boolean; coste: number; latencia_ms: number }
export interface Fitness { entidad_id: string; n: number; exitos: number; tasa: number; wilson_bajo: number; wilson_alto: number; coste_medio: number; evidencia: boolean }
export interface Necesidad { tipo: 'fracaso_dominio' | 'fracaso_banda' | 'refuerzo_dominio'; entidad_id: string; detalle: string; n: number; tasa: number; wilson_bajo: number; wilson_alto: number }
type Entidad = { id: string; provider?: string | null; model?: string | null; aptitud?: Aptitud | null; [k: string]: unknown };
type PerfilEvo = Perfil & { generation?: number; parents?: string[]; origin?: string; mutation_note?: string };

/** Mismo generador congruencial que `Azar` en Python. */
export class Azar {
  private estado: number;
  constructor(semilla = 0) { this.estado = semilla >>> 0; }
  random(): number { this.estado = (Math.imul(this.estado, 1664525) + 1013904223) >>> 0; return this.estado / 4294967296; }
}

const copia = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const pct = (x: number) => (x * 100).toFixed(0);
/** `round(x, n)` de Python en los rangos que usamos (suficiente para pasos de 0.001). */
const redondear = (x: number, n: number) => Math.round(x * 10 ** n) / 10 ** n;

/** Filas de `runs` ⨝ `tasks` → muestras (la lectura SQL vive en `Almacen.filasEvolucion`). */
export function muestrasDeFilas(filas: Record<string, unknown>[]): Muestra[] {
  return filas.map((f) => {
    let dominios: string[] = [];
    try { dominios = (JSON.parse(String(f['classification_json'])) as { domain?: string[] }).domain ?? []; } catch { /* sin dominios */ }
    return {
      profile_id: (f['profile_id'] as string | null) ?? null, clave: [String(f['provider_name']), String(f['model_id'] ?? '')], complejidad: Number(f['score']),
      areas: areasDeTarea(String(f['prompt'] ?? ''), dominios), ok: f['status'] === 'completed', coste: Number(f['estimated_cost_usd'] ?? 0), latencia_ms: Number(f['latency_ms'] ?? 0),
    };
  });
}

export function wilson(exitos: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = exitos / n, den = 1 + (z * z) / n;
  const centro = (p + (z * z) / (2 * n)) / den;
  const margen = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centro - margen), Math.min(1, centro + margen)];
}

export const banda = (complejidad: number) => Math.floor(complejidad * 2) / 2;
const clave = (e: Entidad): [string, string] => [e.provider ?? '', e.model ?? ''];
const mismaClave = (a: [string, string], b: [string, string]) => a[0] === b[0] && a[1] === b[1];
const propias = (p: Perfil, ms: Muestra[]) => ms.filter((m) => m.profile_id === p.id);

function calcular(entidadId: string, sub: Muestra[]): Fitness {
  const n = sub.length, exitos = sub.filter((m) => m.ok).length;
  const [bajo, alto] = wilson(exitos, n);
  return { entidad_id: entidadId, n, exitos, tasa: n ? exitos / n : 0, wilson_bajo: bajo, wilson_alto: alto, coste_medio: n ? sub.reduce((s, m) => s + m.coste, 0) / n : 0, evidencia: n >= MIN_MUESTRAS };
}

export function fitnessPerfil(perfil: Perfil, muestras: Muestra[]): Fitness[] {
  const mias = propias(perfil, muestras);
  return (perfil.entities as Entidad[]).filter((e) => e.provider).map((e) => calcular(e.id, mias.filter((m) => mismaClave(m.clave, clave(e)))));
}

const gravedad = (n: Necesidad) => (n.tipo.startsWith('fracaso') ? n.wilson_alto : 1 + (1 - n.wilson_bajo));
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function explicacion(n: Necesidad): string {
  const que = n.tipo.endsWith('dominio') ? `área «${n.detalle}»` : `banda de complejidad ${n.detalle}`;
  return `${que}: ${pct(n.tasa)} % de éxito (IC95 ${pct(n.wilson_bajo)}–${pct(n.wilson_alto)} %) en ${n.n} ejecuciones con ${n.entidad_id}`;
}

export function detectarNecesidades(perfil: Perfil, muestras: Muestra[]): Necesidad[] {
  const mias = propias(perfil, muestras);
  const out: Necesidad[] = [];
  for (const e of perfil.entities as Entidad[]) {
    if (!e.provider || !e.aptitud) continue;
    const suyas = mias.filter((m) => mismaClave(m.clave, clave(e)));
    for (const area of [...new Set(suyas.flatMap((m) => m.areas))].sort()) {
      const f = calcular(e.id, suyas.filter((m) => m.areas.includes(area)));
      if (!f.evidencia) continue;
      const base = { entidad_id: e.id, detalle: area, n: f.n, tasa: f.tasa, wilson_bajo: f.wilson_bajo, wilson_alto: f.wilson_alto };
      if (f.wilson_alto < EXITO_OBJETIVO) out.push({ tipo: 'fracaso_dominio', ...base });
      else if (f.wilson_bajo >= EXITO_SOBRESALIENTE) out.push({ tipo: 'refuerzo_dominio', ...base });
    }
    for (const b of [...new Set(suyas.map((m) => banda(m.complejidad)))].sort((x, y) => x - y)) {
      const f = calcular(e.id, suyas.filter((m) => banda(m.complejidad) === b));
      if (f.evidencia && f.wilson_alto < EXITO_OBJETIVO) out.push({ tipo: 'fracaso_banda', entidad_id: e.id, detalle: `${b.toFixed(1)}–${(b + 0.5).toFixed(1)}`, n: f.n, tasa: f.tasa, wilson_bajo: f.wilson_bajo, wilson_alto: f.wilson_alto });
    }
  }
  return out.sort((a, b) => gravedad(a) - gravedad(b) || cmp(a.entidad_id, b.entidad_id) || cmp(a.detalle, b.detalle));
}

const acotar = (v: number) => redondear(Math.min(1, Math.max(0, v)), 3);

function hijoDe(padre: PerfilEvo, id: string, origen: string, padres: string[], generacion: number): PerfilEvo {
  const h = copia(padre);
  h.id = id;
  h.name = `${padre.name.split(' · g')[0]} · g${generacion}`.slice(0, 100);
  h.generation = generacion; h.parents = padres; h.origin = origen; h.mutation_note = '';
  return h;
}

export function mutar(perfil: PerfilEvo, n: Necesidad, azar: Azar, hijoId: string): PerfilEvo | null {
  const hijo = hijoDe(perfil, hijoId, 'mutacion', [perfil.id], (perfil.generation ?? 0) + 1);
  const entidad = (hijo.entities as Entidad[]).find((e) => e.id === n.entidad_id && e.aptitud);
  if (!entidad) return null;
  const apt = entidad.aptitud!;
  const paso = redondear(PASO_BASE + PASO_ALEATORIO * azar.random(), 3);
  let cambio: string;
  if (n.tipo === 'fracaso_dominio' || n.tipo === 'refuerzo_dominio') {
    const antes = apt.afinidad_dominio[n.detalle] ?? 0.4;
    apt.afinidad_dominio[n.detalle] = acotar(n.tipo === 'fracaso_dominio' ? antes - paso : antes + paso / 2);
    cambio = `afinidad «${n.detalle}» de ${entidad.id}: ${antes.toFixed(2)}→${apt.afinidad_dominio[n.detalle]!.toFixed(2)}`;
  } else {
    const inicio = Number(n.detalle.split('–')[0]);
    if (inicio <= apt.optimo && apt.optimo < inicio + 0.5) return null;
    let [low, high] = apt.rango_complejidad;
    const [antesLow, antesHigh] = [low, high];
    if (inicio >= apt.optimo) high = Math.max(low, Math.min(high, inicio));
    else low = Math.min(high, Math.max(low, inicio + 0.5));
    if (low === antesLow && high === antesHigh) return null;
    apt.rango_complejidad = [low, high];
    apt.optimo = Math.min(high, Math.max(low, apt.optimo));
    cambio = `rango de ${entidad.id}: ${antesLow.toFixed(1)}–${antesHigh.toFixed(1)}→${low.toFixed(1)}–${high.toFixed(1)}`;
  }
  hijo.mutation_note = `${explicacion(n)}. Cambio: ${cambio}.`.slice(0, 600);
  return hijo;
}

export function cruzar(a: PerfilEvo, b: PerfilEvo, muestras: Muestra[], hijoId: string): PerfilEvo | null {
  const fa = new Map(fitnessPerfil(a, muestras).map((f) => [f.entidad_id, f]));
  const fb = new Map(fitnessPerfil(b, muestras).map((f) => [f.entidad_id, f]));
  const porId = new Map((b.entities as Entidad[]).map((e) => [e.id, e]));
  const hijo = hijoDe(a, hijoId, 'cruce', [a.id, b.id].sort(), Math.max(a.generation ?? 0, b.generation ?? 0) + 1);
  const cambios: string[] = [];
  for (const e of hijo.entities as Entidad[]) {
    const otra = porId.get(e.id);
    if (!otra?.aptitud || JSON.stringify(e.aptitud) === JSON.stringify(otra.aptitud)) continue;
    const x = fa.get(e.id), y = fb.get(e.id);
    if (y?.evidencia && (!x || !x.evidencia || y.wilson_bajo > x.wilson_bajo)) {
      e.aptitud = copia(otra.aptitud);
      cambios.push(`${e.id} de ${b.id} (IC95 inferior ${pct(y.wilson_bajo)} %)`);
    }
  }
  if (!cambios.length) return null;
  hijo.mutation_note = `Cruce de ${a.id} × ${b.id}: hereda ${cambios.join('; ')}.`.slice(0, 600);
  return hijo;
}

/** Hijos propuestos (inactivos) desde el perfil por defecto y, si hay, otros con evidencia. No modifica nada. */
export function proponerGeneracion(perfiles: PerfilEvo[], defectoId: string, muestras: Muestra[], semilla = 0): PerfilEvo[] {
  const azar = new Azar(semilla);
  const base = perfiles.find((p) => p.id === defectoId)!;
  const ids = new Set(perfiles.map((p) => p.id));
  const hijos: PerfilEvo[] = [];
  const siguiente = (origen: PerfilEvo) => {
    const raiz = origen.id.split('-g')[0]!.slice(0, 60);
    let k = 1;
    while (ids.has(`${raiz}-g${k}`)) k++;
    return `${raiz}-g${k}`;
  };
  const aceptar = (h: PerfilEvo | null) => { if (h) { ids.add(h.id); hijos.push(h); } }; // el id solo se gasta si nace un hijo
  for (const n of detectarNecesidades(base, muestras)) {
    if (hijos.length >= MAX_HIJOS) break;
    aceptar(mutar(base, n, azar, siguiente(base)));
  }
  for (const otro of perfiles.filter((p) => p.id !== base.id && p.entities.length)) {
    if (hijos.length >= MAX_HIJOS) break;
    aceptar(cruzar(base, otro, muestras, siguiente(base)));
  }
  return hijos;
}
