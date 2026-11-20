import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NIVELES, type NivelModelo } from './planificador-modos';
import type { PlanEjecucion } from './planificador';

/**
 * Configuración y registro del planificador. Van en `<datos>/planificador.json` y `<datos>/planificador-planes.json`: un plan guardado
 * es la evidencia de por qué se ejecutó así, y su resultado (con los fallos como fallos) es lo que permite revisarlo después.
 * Nada aquí lanza un agente: quien ejecuta (la cola de Atlas dev) lee el plan y avisa del resultado.
 */
export interface ConfigPlanificador {
  /** Por agente: si se usa y, por nivel, los modelos preferidos (fragmentos del nombre; el primero disponible gana). Son preferencias, no identificadores garantizados. */
  agentes: Record<string, { activo: boolean; niveles: Record<NivelModelo, string[]> }>;
  /** Peso de cada criterio al comparar formatos en `auto` (se normalizan). */
  pesos: { coste: number; tiempo: number; riesgo: number };
  /** Coste relativo de un modelo según su nivel (el superior vale 1). */
  pesoNivel: Record<NivelModelo, number>;
  jefe: { intervencionMin: number; referencia: string[] };
  /** Nivel de complejidad (1-5) desde el que `auto` propone hitos. */
  hitosDesdeNivel: number;
  maxSubagentes: number;
  /** Ámbitos por defecto de los especialistas de co-work, por dominio. */
  ambitos: Record<string, string[]>;
}

export const CONFIG_POR_DEFECTO: ConfigPlanificador = {
  agentes: {
    claude: { activo: true, niveles: { superior: ['opus', 'fable'], medio: ['sonnet'], bajo: ['haiku'] } },
    codex: { activo: true, niveles: { superior: ['sol', 'astra'], medio: ['terra'], bajo: ['luna'] } },
    gemini: { activo: true, niveles: { superior: ['pro'], medio: ['flash'], bajo: ['flash-lite', 'flash'] } },
  },
  pesos: { coste: 0.4, tiempo: 0.25, riesgo: 0.35 },
  pesoNivel: { superior: 1, medio: 0.45, bajo: 0.12 },
  jefe: { intervencionMin: 5, referencia: ['opus', 'fable', 'asura', 'sol'] },
  hitosDesdeNivel: 4,
  maxSubagentes: 4,
  ambitos: { programming: ['backend', 'frontend', 'pruebas'], default: ['implementación', 'revisión'] },
};

const num = (v: unknown, def: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
const lista = (v: unknown, def: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim() && x.length <= 60).map((x) => x.trim()).slice(0, 12) : def);

/** Completa y acota cualquier entrada: nunca lanza, y lo que no cumple vuelve al valor por defecto. */
export function normalizarConfig(entrada: unknown): ConfigPlanificador {
  const d = CONFIG_POR_DEFECTO, e = (entrada && typeof entrada === 'object' ? entrada : {}) as Record<string, unknown>;
  const agentes: ConfigPlanificador['agentes'] = {};
  const ea = (e['agentes'] && typeof e['agentes'] === 'object' ? e['agentes'] : {}) as Record<string, { activo?: unknown; niveles?: Record<string, unknown> }>;
  for (const id of new Set([...Object.keys(d.agentes), ...Object.keys(ea)])) {
    if (!/^[a-z][a-z0-9-]{0,30}$/.test(id)) continue;
    const base = d.agentes[id] ?? { activo: true, niveles: { superior: [], medio: [], bajo: [] } };
    agentes[id] = { activo: typeof ea[id]?.activo === 'boolean' ? ea[id]!.activo as boolean : base.activo, niveles: Object.fromEntries(NIVELES.map((n) => [n, lista(ea[id]?.niveles?.[n], base.niveles[n])])) as Record<NivelModelo, string[]> };
  }
  const p = (e['pesos'] ?? {}) as Record<string, unknown>, pn = (e['pesoNivel'] ?? {}) as Record<string, unknown>, j = (e['jefe'] ?? {}) as Record<string, unknown>, am = (e['ambitos'] ?? {}) as Record<string, unknown>;
  return {
    agentes,
    pesos: { coste: num(p['coste'], d.pesos.coste, 0, 10), tiempo: num(p['tiempo'], d.pesos.tiempo, 0, 10), riesgo: num(p['riesgo'], d.pesos.riesgo, 0, 10) },
    pesoNivel: { superior: num(pn['superior'], d.pesoNivel.superior, 0.01, 10), medio: num(pn['medio'], d.pesoNivel.medio, 0.01, 10), bajo: num(pn['bajo'], d.pesoNivel.bajo, 0.01, 10) },
    jefe: { intervencionMin: Math.round(num(j['intervencionMin'], d.jefe.intervencionMin, 1, 30)), referencia: lista(j['referencia'], d.jefe.referencia) },
    hitosDesdeNivel: Math.round(num(e['hitosDesdeNivel'], d.hitosDesdeNivel, 1, 5)), maxSubagentes: Math.round(num(e['maxSubagentes'], d.maxSubagentes, 1, 8)),
    ambitos: { ...d.ambitos, ...Object.fromEntries(Object.entries(am).map(([k, v]) => [k, lista(v, d.ambitos[k] ?? d.ambitos['default']!)]).filter(([, v]) => (v as string[]).length)) },
  };
}

function leerJson(ruta: string): unknown { try { return existsSync(ruta) ? JSON.parse(readFileSync(ruta, 'utf8')) : null; } catch { return null; } }
function escribirJson(ruta: string, valor: unknown) {
  mkdirSync(dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(valor, null, 2), 'utf8');
  renameSync(tmp, ruta);
}

export const leerConfig = (ruta: string) => normalizarConfig(leerJson(ruta));
export function guardarConfig(ruta: string, parcial: unknown): ConfigPlanificador {
  const actual = leerConfig(ruta), p = (parcial && typeof parcial === 'object' && !Array.isArray(parcial) ? parcial : {}) as Record<string, unknown>;
  const nueva = normalizarConfig({ ...actual, ...p, agentes: { ...actual.agentes, ...((p['agentes'] as object) ?? {}) }, pesos: { ...actual.pesos, ...((p['pesos'] as object) ?? {}) }, pesoNivel: { ...actual.pesoNivel, ...((p['pesoNivel'] as object) ?? {}) }, jefe: { ...actual.jefe, ...((p['jefe'] as object) ?? {}) } });
  escribirJson(ruta, nueva);
  return nueva;
}

// ── Registro de planes y resultados ─────────────────────────────────────────────────────────────
export type EstadoPlan = 'planificado' | 'ejecutando' | 'completado' | 'fallido' | 'bloqueado' | 'cancelado';
export interface HallazgoChecker { severidad: 'alta' | 'media' | 'baja'; titulo: string; detalle?: string; pendiente?: boolean }
export interface ResultadoChecker { estado: 'limpio' | 'hallazgos' | 'fallido'; resumen: string; hallazgos: HallazgoChecker[]; en: string }
export interface EventoPlan { en: string; tipo: 'plan' | 'estado' | 'hito' | 'checker' | 'decision' | 'fallo'; detalle: string }
export interface RegistroPlan { tarea: string; plan: PlanEjecucion; estado: EstadoPlan; creado: string; actualizado: string; eventos: EventoPlan[]; checker?: ResultadoChecker }
type Planes = Record<string, RegistroPlan>;

const MAX_PLANES = 300, MAX_EVENTOS = 200;
const leerPlanes = (ruta: string): Planes => { const j = leerJson(ruta); return j && typeof j === 'object' && !Array.isArray(j) ? j as Planes : {}; };
const recortar = (p: Planes): Planes => Object.fromEntries(Object.entries(p).sort((a, b) => b[1].actualizado.localeCompare(a[1].actualizado)).slice(0, MAX_PLANES));
const ESTADOS: EstadoPlan[] = ['planificado', 'ejecutando', 'completado', 'fallido', 'bloqueado', 'cancelado'];

export function guardarPlan(ruta: string, tarea: string, plan: PlanEjecucion, ahora = new Date().toISOString()): RegistroPlan {
  const todos = leerPlanes(ruta), previo = todos[tarea];
  const eventos = [...(previo?.eventos ?? []), { en: ahora, tipo: 'plan' as const, detalle: `${plan.modo}${plan.modificadores.length ? ` + ${plan.modificadores.join(' + ')}` : ''}: ${plan.motivo}`.slice(0, 500) }].slice(-MAX_EVENTOS);
  const reg: RegistroPlan = { tarea, plan, estado: plan.errores.length ? 'fallido' : 'planificado', creado: previo?.creado ?? ahora, actualizado: ahora, eventos, ...(previo?.checker ? { checker: previo.checker } : {}) };
  escribirJson(ruta, recortar({ ...todos, [tarea]: reg }));
  return reg;
}

/** Anota un evento y, si trae `estado`, lo cambia. Devuelve null si el plan no existe. Un estado desconocido se rechaza. */
export function anotarEvento(ruta: string, tarea: string, ev: { tipo: EventoPlan['tipo']; detalle: string; estado?: string }, ahora = new Date().toISOString()): RegistroPlan | null {
  const todos = leerPlanes(ruta), r = todos[tarea];
  if (!r) return null;
  if (ev.estado !== undefined && !ESTADOS.includes(ev.estado as EstadoPlan)) throw new Error(`estado: ${ESTADOS.join(' | ')}`);
  const nuevo: RegistroPlan = { ...r, estado: (ev.estado as EstadoPlan | undefined) ?? r.estado, actualizado: ahora, eventos: [...r.eventos, { en: ahora, tipo: ev.tipo, detalle: ev.detalle.slice(0, 500) }].slice(-MAX_EVENTOS) };
  escribirJson(ruta, recortar({ ...todos, [tarea]: nuevo }));
  return nuevo;
}

/** Guarda el resultado del checker. Un checker que falló NO cuenta como «limpio»: queda como `fallido` y el plan como bloqueado. */
export function guardarChecker(ruta: string, tarea: string, c: { estado: string; resumen?: string; hallazgos?: unknown }, ahora = new Date().toISOString()): RegistroPlan | null {
  const todos = leerPlanes(ruta), r = todos[tarea];
  if (!r) return null;
  const hallazgos: HallazgoChecker[] = (Array.isArray(c.hallazgos) ? c.hallazgos : []).slice(0, 100).flatMap((h) => {
    const x = (h ?? {}) as Record<string, unknown>;
    if (typeof x['titulo'] !== 'string' || !x['titulo'].trim()) return [];
    return [{ severidad: (['alta', 'media', 'baja'] as const).includes(x['severidad'] as 'alta') ? x['severidad'] as 'alta' : 'media', titulo: x['titulo'].trim().slice(0, 200), ...(typeof x['detalle'] === 'string' ? { detalle: x['detalle'].slice(0, 2000) } : {}), ...(x['pendiente'] === true ? { pendiente: true } : {}) }];
  });
  const estado: ResultadoChecker['estado'] = c.estado === 'fallido' ? 'fallido' : hallazgos.length ? 'hallazgos' : 'limpio';
  const checker: ResultadoChecker = { estado, resumen: (c.resumen ?? '').slice(0, 1000) || (estado === 'limpio' ? 'Sin hallazgos' : estado === 'fallido' ? 'El checker no pudo completar la revisión' : `${hallazgos.length} hallazgo(s)`), hallazgos, en: ahora };
  const detalle = `checker ${estado}: ${checker.resumen}`;
  const nuevo: RegistroPlan = { ...r, checker, actualizado: ahora, estado: estado === 'fallido' ? 'bloqueado' : r.estado, eventos: [...r.eventos, { en: ahora, tipo: (estado === 'fallido' ? 'fallo' : 'checker') as EventoPlan['tipo'], detalle: detalle.slice(0, 500) }].slice(-MAX_EVENTOS) };
  escribirJson(ruta, recortar({ ...todos, [tarea]: nuevo }));
  return nuevo;
}

export const leerPlan = (ruta: string, tarea: string): RegistroPlan | null => leerPlanes(ruta)[tarea] ?? null;
export const listarPlanes = (ruta: string, limite = 50): RegistroPlan[] => Object.values(leerPlanes(ruta)).sort((a, b) => b.actualizado.localeCompare(a.actualizado)).slice(0, limite);
