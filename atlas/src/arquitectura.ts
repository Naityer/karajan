import type { Almacen } from './almacen';
import { construirAnaliticaSkills } from './analitica';
import { listarSkills } from './catalogo';
import { COMPONENTES, ENLACES, FAMILIAS, type Componente, type Enlace } from './componentes';
import { FICHAS, type ContextoFicha, type ValorConfig } from './fichas-componentes';
import type { Ejecucion, RegistroLab } from './laboratorio';
import type { Hallazgo, Pasarela, Severidad } from './pasarela-borradores';
import { produccion } from './produccion';
import type { Rotador } from './rotador';

/**
 * Datos de la ventana «Arquitectura» de Atlas dev (`GET /laboratorio/arquitectura`): por componente, su familia, módulos,
 * estado del laboratorio, ficha («cómo funciona» y configuración viva), últimas ejecuciones, historial de métricas, hallazgos con
 * su borrador y la actividad real (`operacion`). Todo es de SOLO LECTURA y barato, y NUNCA lanza: una fuente que falla deja su
 * campo a null y anota el motivo en `avisos` del componente.
 */
export const VERSION_CONTRATO = 1;
const MAX_HISTORIAL = 30;
/** Con `completo` (detalle de un componente) el historial llega hasta aquí. */
const MAX_HISTORIAL_COMPLETO = 500;

export type EstadoComponente = 'ok' | 'hallazgos' | 'sin_ejecutar' | 'pendiente' | 'error';

export interface ContextoArquitectura extends ContextoFicha {
  registro: Pick<RegistroLab, 'ejecuciones'>;
  almacen: Pick<Almacen, 'resumenOperacion' | 'tareasPlanas' | 'listarTareas' | 'runs' | 'revisiones'>;
  pasarela: Pick<Pasarela, 'leer'> & Partial<Pick<Pasarela, 'listar'>>;
  rotador: Pick<Rotador, 'leerEstado' | 'inventario'>;
  ahora?: () => Date;
  /** Memoria de los cálculos más caros (KPI de producción e inventario de skills); sin ella, o con `ttlMs` 0, se recalculan siempre. */
  cache?: Map<string, { en: number; valor: unknown }>;
  ttlMs?: number;
  /** Cuánto esperar al estado de los borradores en Atlas dev antes de dejarlos sin estado. */
  esperaBorradoresMs?: number;
}

export interface Operacion {
  tareas: number | null; runs: number | null; latencia_p50_ms: number | null; coste_total_usd: number | null;
  tokens: { entrada: number; salida: number; total: number } | null; ultima_actividad: string | null;
  /** Lo propio de cada componente (niveles del rotador, KPI de producción, límites…). */
  extra: Record<string, unknown> | null;
}
const SIN_OPERACION: Operacion = { tareas: null, runs: null, latencia_p50_ms: null, coste_total_usd: null, tokens: null, ultima_actividad: null, extra: null };

export interface PuntoHistorial { inicio: string; valor: number; suficiente: boolean; escenario: string }
export interface UltimaEjecucion { escenario: string; inicio: string; muestra: number; suficiente: boolean; hallazgos: number; error: string | null; metricas: Record<string, number | null>; ms: number; detalle?: unknown }
export interface HallazgoVista extends Hallazgo { escenario: string; borrador: { tarea: string; creada: string; estado: string | null } | null }

export interface ComponenteVista {
  id: string; familia: string; responsabilidad: string; modulos: string[];
  estado: EstadoComponente; muestra_corta: boolean; pendiente: string | null;
  ficha: { especificado: boolean; resumen: string; como_funciona: { entradas: string[]; pasos: string[]; salidas: string[] }; reglas: string[] };
  configuracion: Record<string, ValorConfig> | null;
  escenarios: { id: string; tipo: string; descripcion: string; umbrales: Record<string, string> | null }[];
  ultimas: UltimaEjecucion[];
  historial: Record<string, PuntoHistorial[]>;
  detalle: Record<string, unknown>;
  hallazgos: HallazgoVista[];
  operacion: Operacion;
  /** Fuentes que fallaron al calcular este componente (el campo correspondiente queda a null o vacío). */
  avisos: string[];
}

export interface Arquitectura {
  version_contrato: number; version: string; modo: string; generado: string;
  familias: { id: string; nombre: string; orden: number; componentes: string[] }[];
  componentes: ComponenteVista[];
  enlaces: Enlace[];
}

/** Estado del componente, con la misma lógica que `estadoDe` de cli.ts. */
export function estadoDe(tieneEscenarios: boolean, ultimas: Pick<UltimaEjecucion, 'error' | 'hallazgos'>[]): EstadoComponente {
  if (!tieneEscenarios) return 'pendiente';
  if (!ultimas.length) return 'sin_ejecutar';
  if (ultimas.some((u) => u.error)) return 'error';
  return ultimas.some((u) => u.hallazgos > 0) ? 'hallazgos' : 'ok';
}

const mensaje = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 300);
const maximo = (...fechas: (string | null | undefined)[]) => fechas.filter((f): f is string => !!f).reduce<string | null>((a, b) => (a === null || b > a ? b : a), null);

/** La última ejecución de cada escenario (las `ejecuciones` vienen de la más nueva a la más antigua). */
function ultimasDe(ejecuciones: Ejecucion[]): Ejecucion[] {
  const vistos = new Set<string>();
  return ejecuciones.filter((e) => !vistos.has(e.escenario) && vistos.add(e.escenario));
}

function historialDe(ejecuciones: Ejecucion[], limite: number): Record<string, PuntoHistorial[]> {
  const h: Record<string, PuntoHistorial[]> = {};
  // De la más antigua a la más reciente; los valores nulos (sin muestra) no son un punto de la serie.
  for (const e of [...ejecuciones].reverse()) {
    for (const [k, v] of Object.entries(e.metricas)) {
      if (typeof v === 'number' && Number.isFinite(v)) (h[k] ??= []).push({ inicio: e.inicio, valor: v, suficiente: e.suficiente, escenario: e.escenario });
    }
  }
  for (const k of Object.keys(h)) h[k] = h[k]!.slice(-limite);
  return h;
}

interface Borrador { tarea: string; creada: string; estado: string | null }

/** Actividad real de cada componente, a partir del registro (task_logs.db), la analítica, el rotador, los límites y la pasarela. */
function operaciones(ctx: ContextoArquitectura, avisar: (id: string, fuente: string, e: unknown) => void): Record<string, Operacion> {
  const salida: Record<string, Operacion> = {};
  const intentar = <T,>(id: string, fuente: string, fn: () => T): T | null => { try { return fn(); } catch (e) { avisar(id, fuente, e); return null; } };
  const memo = <T,>(clave: string, fn: () => T): T => {
    const ttl = ctx.ttlMs ?? 0, hit = ctx.cache?.get(clave);
    if (ttl > 0 && ctx.cache && hit && Date.now() - hit.en < ttl) return hit.valor as T;
    const valor = fn();
    if (ttl > 0) ctx.cache?.set(clave, { en: Date.now(), valor });
    return valor;
  };

  const r = intentar('almacen', 'task_logs.db', () => ctx.almacen.resumenOperacion());
  if (r) {
    const runs = r.proveedores.reduce((s, p) => s + p.runs, 0);
    const entrada = r.proveedores.reduce((s, p) => s + p.tokens_entrada, 0), salidaT = r.proveedores.reduce((s, p) => s + p.tokens_salida, 0);
    const coste = Math.round(r.proveedores.reduce((s, p) => s + p.coste_usd, 0) * 1e5) / 1e5;
    const fase = (f: string) => r.fases[f];
    salida['almacen'] = { tareas: r.tareas.total, runs, latencia_p50_ms: r.latencia_p50_ms, coste_total_usd: coste, tokens: { entrada, salida: salidaT, total: entrada + salidaT }, ultima_actividad: maximo(r.tareas.ultima_actualizada, r.tareas.ultima_creada),
      extra: { delegadas: r.tareas.delegadas, decisiones_por_fase: Object.fromEntries(Object.entries(r.fases).map(([k, v]) => [k, v.n])), metrics_history: r.metrics_history } };
    salida['clasificador'] = { ...SIN_OPERACION, tareas: fase('classify')?.tareas ?? 0, ultima_actividad: fase('classify')?.ultima ?? null, extra: { decisiones: fase('classify')?.n ?? 0, validaciones: fase('validate')?.n ?? 0 } };
    salida['delegador'] = { ...SIN_OPERACION, tareas: r.tareas.delegadas, ultima_actividad: maximo(fase('assign')?.ultima, fase('delegate')?.ultima),
      extra: { asignaciones: fase('assign')?.n ?? 0, respaldos: fase('fallback')?.n ?? 0, reasignaciones: fase('reassign')?.n ?? 0, ejecuciones: fase('delegate')?.n ?? 0 } };
    salida['proveedores'] = { tareas: null, runs, latencia_p50_ms: r.latencia_p50_ms, coste_total_usd: coste, tokens: { entrada, salida: salidaT, total: entrada + salidaT }, ultima_actividad: maximo(...r.proveedores.map((p) => p.ultima)), extra: { por_proveedor: r.proveedores } };
    salida['aislamiento'] = { ...SIN_OPERACION, tareas: r.git.tareas, ultima_actividad: r.git.ultima, extra: { decisiones_git: r.git.n } };
    salida['rotador'] = { ...SIN_OPERACION, tareas: r.skills.tareas, ultima_actividad: r.skills.ultima, extra: { decisiones_de_skill: r.skills.n } };
  }

  const planas = intentar('selector', 'tareas del registro', () => ctx.almacen.tareasPlanas());
  if (planas) {
    const conSkills = planas.filter((t) => t.recomendadas.length);
    salida['selector'] = { ...SIN_OPERACION, tareas: conSkills.length, ultima_actividad: maximo(...conSkills.map((t) => t.created_at)),
      extra: { con_skill_ejecutada: planas.filter((t) => t.ejecutadas.length).length, skills_distintas_recomendadas: new Set(conSkills.flatMap((t) => t.recomendadas)).size } };
    const p = intentar('produccion', 'analítica de producción', () => memo('produccion', () => produccion(planas, { catalogo: [], agentesPerfil: null, dias: 0, ahora: ctx.ahora?.() ?? new Date() })));
    if (p) salida['produccion'] = { ...SIN_OPERACION, tareas: p.kpis.tareas, ultima_actividad: p.ultima, extra: { ...p.kpis } };
  }

  const a = intentar('analitica', 'analítica de skills', () => {
    const registros = ctx.almacen.listarTareas();
    const runsPorTarea = Object.fromEntries(registros.filter((x) => x.delegation).map((x) => [x.task_id, ctx.almacen.runs(x.task_id)]));
    const revisadas = Object.fromEntries(Object.entries(ctx.almacen.revisiones()).map(([id, campos]) => [id, campos['skills_usadas'] ?? []]));
    return construirAnaliticaSkills(registros, { runsPorTarea, skillsRevisadasPorTarea: revisadas, skillsConocidas: listarSkills().map((s) => s.name), dias: 30, ahora: ctx.ahora?.() });
  }) as { summary: Record<string, number | null>; skills: { last_used_at: string | null }[] } | null;
  if (a) salida['analitica'] = { ...SIN_OPERACION, tareas: a.summary['recommended_tasks'] ?? null, runs: a.summary['executions'] ?? null, ultima_actividad: maximo(...a.skills.map((s) => s.last_used_at)), extra: { dias: 30, ...a.summary } };

  const rot = intentar('rotador', 'inventario de skills', () => memo('rotador', () => {
    const inv = ctx.rotador.inventario();
    const cuenta = (n: string) => inv.filter((f) => f.nivel === n && f.instaladaEn.length).length;
    // Lo mismo que `Rotador.plan()`, contado sobre el inventario ya leído (plan() lo recorre otra vez).
    const retirar = inv.filter((f) => f.nivel === 'inactiva' && !f.protegida).reduce((s, f) => s + f.instaladaEn.length, 0);
    const reponer = inv.filter((f) => (f.nivel === 'nucleo' || f.nivel === 'frecuente')).reduce((s, f) => s + f.enAlmacen.filter((d) => !f.instaladaEn.includes(d)).length, 0);
    return { nucleo: cuenta('nucleo'), frecuente: cuenta('frecuente'), instantanea: cuenta('instantanea'), inactivas_instaladas: cuenta('inactiva'), en_almacen: inv.filter((f) => f.enAlmacen.length && !f.instaladaEn.length).length, por_retirar: retirar, por_reponer: reponer,
      ultima: maximo(...Object.values(ctx.rotador.leerEstado().repuestas)) };
  }));
  if (rot) {
    const { ultima, ...resto } = rot;
    salida['rotador'] = { ...(salida['rotador'] ?? SIN_OPERACION), ultima_actividad: maximo(salida['rotador']?.ultima_actividad, ultima), extra: { ...(salida['rotador']?.extra ?? {}), ...resto } };
  }

  const l = intentar('limites', 'limites-plan.json', () => ctx.limites());
  salida['limites'] = { ...SIN_OPERACION, ultima_actividad: l?.leido ?? null, extra: l ? { claude_semanal: l.claude?.semanal ?? null, claude_sesion: l.claude?.sesion ?? null, codex_semanal: l.codex?.semanal ?? null, reinicio_claude: l.claude?.reinicio ?? null } : { dato_reciente: false } };

  const reg = intentar('pasarela', 'borradores.json', () => ctx.pasarela.leer() as Record<string, { creada?: string }>);
  if (reg) salida['pasarela'] = { ...SIN_OPERACION, tareas: Object.keys(reg).length, ultima_actividad: maximo(...Object.values(reg).map((v) => v.creada)), extra: { borradores: Object.keys(reg).length } };

  const lab = intentar('laboratorio', 'laboratorio.db', () => ctx.registro.ejecuciones(undefined, 1)[0] ?? null);
  salida['laboratorio'] = { ...SIN_OPERACION, ultima_actividad: lab?.inicio ?? null, extra: { ultima_ejecucion: lab ? `${lab.componente}/${lab.escenario}` : null } };
  salida['modo'] = { ...SIN_OPERACION, extra: { modo: ctx.modo } };
  return salida;
}

async function estadosBorradores(ctx: ContextoArquitectura): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  if (!ctx.pasarela.listar) return m;
  try {
    const lista = await Promise.race([ctx.pasarela.listar(), new Promise<never>((_, no) => setTimeout(() => no(new Error('tiempo agotado')), ctx.esperaBorradoresMs ?? 1500).unref())]);
    for (const b of lista) if (b.estado !== 'desconocida') m.set(b.clave, b.estado);
  } catch { /* Atlas dev no responde: los borradores salen sin estado */ }
  return m;
}

/**
 * Construye el contrato completo. Con `id` solo trae ese componente (o `null` si no existe) y, como en el detalle, con el
 * historial completo y el `detalle` dentro de cada `ultima`.
 */
export async function construirArquitectura(ctx: ContextoArquitectura, op: { id?: string } = {}): Promise<Arquitectura | ComponenteVista | null> {
  const completo = op.id !== undefined;
  const elegidos: Componente[] = completo ? COMPONENTES.filter((c) => c.id === op.id) : COMPONENTES;
  if (completo && !elegidos.length) return null;

  const avisos = new Map<string, string[]>();
  const avisar = (id: string, fuente: string, e: unknown) => avisos.set(id, [...(avisos.get(id) ?? []), `${fuente}: ${mensaje(e)}`]);
  const ops = (() => { try { return operaciones(ctx, avisar); } catch (e) { avisar('almacen', 'operación', e); return {} as Record<string, Operacion>; } })();
  const borradores = await estadosBorradores(ctx);
  const registrados = (() => { try { return ctx.pasarela.leer() as Record<string, { tarea: string; creada: string }>; } catch { return {}; } })();

  const vistas = elegidos.map((c): ComponenteVista => {
    const mios = (fuente: string, e: unknown) => avisar(c.id, fuente, e);
    let ejecuciones: Ejecucion[] = [];
    if (c.laboratorio) {
      try {
        // La más reciente primero, por fecha de inicio (a igualdad, por orden de guardado).
        ejecuciones = ctx.registro.ejecuciones(c.id, completo ? 2000 : 300).sort((x, y) => (x.inicio < y.inicio ? 1 : x.inicio > y.inicio ? -1 : y.id - x.id));
      } catch (e) { mios('laboratorio.db', e); }
    }
    const ultimas = ultimasDe(ejecuciones);
    const vistaUltimas: UltimaEjecucion[] = ultimas.map((e) => ({ escenario: e.escenario, inicio: e.inicio, muestra: e.muestra, suficiente: e.suficiente, hallazgos: e.hallazgos.length, error: e.error, metricas: e.metricas, ms: e.ms, ...(completo ? { detalle: e.detalle } : {}) }));
    const ficha = FICHAS[c.id];
    let configuracion: Record<string, ValorConfig> | null = null;
    try { configuracion = ficha ? ficha.configuracion(ctx) : null; } catch (e) { mios('configuración', e); }
    const hallazgos: HallazgoVista[] = ultimas.flatMap((e) => e.hallazgos.map((h) => {
      const clave = `${c.id}:${h.clave}`, reg = registrados[clave];
      return { ...h, severidad: h.severidad as Severidad, escenario: e.escenario, borrador: reg ? { tarea: reg.tarea, creada: reg.creada, estado: borradores.get(clave) ?? null } : null };
    }));
    return {
      id: c.id, familia: c.familia, responsabilidad: c.responsabilidad, modulos: c.modulos,
      estado: estadoDe(!!c.laboratorio, vistaUltimas), muestra_corta: vistaUltimas.some((u) => !u.suficiente), pendiente: c.pendiente ?? null,
      ficha: ficha ? { especificado: ficha.especificado, resumen: ficha.resumen, como_funciona: ficha.como_funciona, reglas: ficha.reglas ?? [] }
        : { especificado: false, resumen: c.responsabilidad, como_funciona: { entradas: [], pasos: [], salidas: [] }, reglas: [] },
      configuracion,
      escenarios: c.laboratorio?.escenarios.map((e) => ({ id: e.id, tipo: e.tipo, descripcion: e.descripcion, umbrales: umbralesDe(ejecuciones, e.id) })) ?? [],
      ultimas: vistaUltimas,
      historial: historialDe(ejecuciones, completo ? MAX_HISTORIAL_COMPLETO : MAX_HISTORIAL),
      detalle: Object.fromEntries(ultimas.map((e) => [e.escenario, e.detalle])),
      hallazgos,
      operacion: ops[c.id] ?? SIN_OPERACION,
      avisos: avisos.get(c.id) ?? [],
    };
  });
  if (completo) return vistas[0]!;
  return {
    version_contrato: VERSION_CONTRATO, version: ctx.version, modo: ctx.modo, generado: (ctx.ahora?.() ?? new Date()).toISOString(),
    familias: FAMILIAS.map((f) => ({ ...f, componentes: COMPONENTES.filter((c) => c.familia === f.id).map((c) => c.id) })),
    componentes: vistas, enlaces: ENLACES,
  };
}

/** Los umbrales con que se juzgó el escenario la última vez que se guardaron (ejecuciones anteriores a esa migración no los traen). */
function umbralesDe(ejecuciones: Ejecucion[], escenario: string): Record<string, string> | null {
  return ejecuciones.find((e) => e.escenario === escenario && e.umbrales)?.umbrales ?? null;
}
