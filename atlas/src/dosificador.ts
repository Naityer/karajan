import {
  CONFIG_BASE, PUNTOS_PRIORIDAD, PRIORIDADES, estadoInicial, normalizarEstado,
  type ConfigDosificador, type EstadoDosificador, type Horario, type Modo, type Prioridad, type VentanaCfg,
} from './dosificador-config';
import { cuotaDeUso, estadoCuota, ventanaDe, type EstadoDato } from './dosificador-cuota';

/**
 * Dosificador: decide CUÁNDO, DÓNDE (equipo) y CON QUÉ agente se lanza cada tarea para llegar a la renovación semanal del plan con
 * el margen configurado. Núcleo PURO: sin ficheros, sin reloj y sin azar (`ahora`, los datos y el estado entran como argumentos;
 * el mismo estado da la misma decisión). Piezas:
 *
 *   estimador   coste de una tarea en % del plan por clase (nivel×dominio×agente): EWMA de media y varianza, p80 = media + z·σ
 *   pacer       techo = límite − margen − reserva personal; línea ideal de gasto hasta el reinicio (ponderada por horario); controlador
 *               P con banda muerta e histéresis (normal/frenado/bloqueado) y un cubo de fichas por agente para las ráfagas
 *   admisión    coste p80 ≤ presupuesto − comprometido en vuelo (leases); tope de la ventana de 5 h; horario de silencio
 *   circuito    por agente: abre al alcanzar un límite y cierra en `resets_at`, nunca por backoff ciego (el backoff solo cubre «no sé cuándo»)
 *   colocación  agente (fijo, preferido por tipo o el de más presupuesto relativo) y equipo (repo ya preparado, menos carga);
 *               los agentes son colas INDEPENDIENTES; prioridad con aging y backfilling
 *
 * Dato ausente o caduco = fail-closed: no se lanza a ciegas (salvo `modoSimulacion`).
 */
export const MIN = 60_000, HORA = 3_600_000, DIA = 86_400_000;

// ── entrada y salida (contrato con Atlas dev) ───────────────────────────────────────────────────
export interface ClasificacionEntrada { nivel_tarea?: string | number; dominio?: string; intencion?: string }
export interface TareaEntrada { id: string; prioridad: Prioridad; creada: number; programada: number | null; agente: string; clasificacion?: ClasificacionEntrada; repo?: string; equipo?: string; modelo?: string }
export interface EquipoEntrada { id: string; disponible: boolean; enCurso: Record<string, number>; repos: string[] }
export interface EntradaDosificador {
  ahora: number; tareas: TareaEntrada[]; equipos: EquipoEntrada[];
  agentes: Record<string, { disponible: boolean; enCurso: number }>;
  uso: Record<string, unknown>; leido?: string;
}
export interface Decision { tarea: string; agente: string; equipo: string; lanzarEn: number | null; motivo: string }
export interface Diferida { tarea: string; hasta: number | null; motivo: string }
export interface ResumenEstado { modo: Modo; burn: number | null; agotamiento: string | null; circuitos: Record<string, boolean> }
export interface InfoAgente {
  datos: EstadoDato; disponible: boolean; usadoPct: number | null; usadoSesionPct: number | null; reinicio: number | null; reinicioSesion: number | null;
  limitePct: number; techoPct: number | null; presupuestoPct: number | null; comprometidoPct: number; reservaPct: number; lineaPct: number | null; errorPct: number | null;
  modo: Modo; retrasoMin: number; tasaPorHora: number | null; burn: number | null; agotamiento: string | null; circuitoHasta: number | null; sinFecha: boolean; fichas: number | null;
}
export interface Resultado { decisiones: Decision[]; diferidas: Diferida[]; estado: EstadoDosificador; resumen: ResumenEstado; agentes: Record<string, InfoAgente> }

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const iso = (ms: number) => new Date(ms).toISOString();
const pct1 = (x: number) => (Math.round(x * 10) / 10).toString();

/** Valida lo que manda el host. Nunca lanza: o la entrada normalizada o un `error` para el 400. */
export function validarEntrada(x: unknown, cfg: ConfigDosificador): { ok: true; entrada: EntradaDosificador } | { ok: false; error: string } {
  const o = obj(x);
  if (!o) return { ok: false, error: 'el cuerpo debe ser un objeto' };
  if (!fin(o['ahora'])) return { ok: false, error: 'ahora: milisegundos desde la época' };
  if (!Array.isArray(o['tareas']) || o['tareas'].length > 2000) return { ok: false, error: 'tareas: lista de hasta 2000' };
  if (!Array.isArray(o['equipos']) || o['equipos'].length > 50) return { ok: false, error: 'equipos: lista de hasta 50' };
  const agentesCrudos = obj(o['agentes']), usoCrudo = obj(o['uso']);
  if (!agentesCrudos) return { ok: false, error: 'agentes: objeto {agente: {disponible, enCurso}}' };
  if (!usoCrudo) return { ok: false, error: 'uso: objeto {agente: {semanal, sesion, reinicio, …}}' };
  if (o['leido'] !== undefined && o['leido'] !== null && (typeof o['leido'] !== 'string' || !Number.isFinite(Date.parse(o['leido'])))) return { ok: false, error: 'leido: fecha ISO' };
  const tareas: TareaEntrada[] = [];
  for (const [i, t] of o['tareas'].entries()) {
    const c = obj(t);
    if (!c || typeof c['id'] !== 'string' || !c['id'] || c['id'].length > 80) return { ok: false, error: `tareas[${i}].id: texto de 1 a 80 caracteres` };
    if (!PRIORIDADES.includes(c['prioridad'] as Prioridad)) return { ok: false, error: `tareas[${i}].prioridad: ${PRIORIDADES.join('|')}` };
    if (!fin(c['creada'])) return { ok: false, error: `tareas[${i}].creada: milisegundos` };
    if (c['programada'] !== undefined && c['programada'] !== null && !fin(c['programada'])) return { ok: false, error: `tareas[${i}].programada: milisegundos o null` };
    const agente = c['agente'] === undefined ? 'auto' : c['agente'];
    if (typeof agente !== 'string' || (agente !== 'auto' && !cfg.planes[agente])) return { ok: false, error: `tareas[${i}].agente: auto|${Object.keys(cfg.planes).join('|')}` };
    const cl = obj(c['clasificacion']) ?? {};
    tareas.push({
      id: c['id'], prioridad: c['prioridad'] as Prioridad, creada: c['creada'], programada: fin(c['programada']) ? c['programada'] : null, agente,
      clasificacion: { nivel_tarea: typeof cl['nivel_tarea'] === 'string' || fin(cl['nivel_tarea']) ? cl['nivel_tarea'] as string | number : undefined, dominio: typeof cl['dominio'] === 'string' ? cl['dominio'] : undefined, intencion: typeof cl['intencion'] === 'string' ? cl['intencion'] : undefined },
      repo: typeof c['repo'] === 'string' ? c['repo'] : undefined, equipo: typeof c['equipo'] === 'string' ? c['equipo'] : undefined, modelo: typeof c['modelo'] === 'string' ? c['modelo'] : undefined,
    });
  }
  const equipos: EquipoEntrada[] = [];
  for (const [i, e] of o['equipos'].entries()) {
    const c = obj(e);
    if (!c || typeof c['id'] !== 'string' || !c['id'] || c['id'].length > 80) return { ok: false, error: `equipos[${i}].id: texto de 1 a 80 caracteres` };
    if (typeof c['disponible'] !== 'boolean') return { ok: false, error: `equipos[${i}].disponible: booleano` };
    const en = obj(c['enCurso']) ?? {};
    equipos.push({ id: c['id'], disponible: c['disponible'], enCurso: Object.fromEntries(Object.entries(en).filter(([, v]) => fin(v)).map(([k, v]) => [k, Math.max(0, v as number)])), repos: Array.isArray(c['repos']) ? c['repos'].filter((r): r is string => typeof r === 'string').slice(0, 500) : [] });
  }
  const agentes: EntradaDosificador['agentes'] = {};
  for (const [k, v] of Object.entries(agentesCrudos)) {
    const a = obj(v);
    if (!a || typeof a['disponible'] !== 'boolean') return { ok: false, error: `agentes.${k}: {disponible: booleano, enCurso: número}` };
    agentes[k] = { disponible: a['disponible'], enCurso: fin(a['enCurso']) ? Math.max(0, a['enCurso']) : 0 };
  }
  return { ok: true, entrada: { ahora: o['ahora'], tareas, equipos, agentes, uso: usoCrudo, leido: typeof o['leido'] === 'string' ? o['leido'] : undefined } };
}

// ── horario ─────────────────────────────────────────────────────────────────────────────────────
const formateadores = new Map<string, Intl.DateTimeFormat>();
function formateador(zona: string): Intl.DateTimeFormat {
  let f = formateadores.get(zona);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: zona, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }); } catch { f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', hourCycle: 'h23', weekday: 'short' }); }
    formateadores.set(zona, f);
  }
  return f;
}
const DIAS_SEMANA = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** Hora (0-23) y día de la semana (0 = domingo) en la zona del horario. */
export function horaLocal(zona: string, ms: number): { hora: number; dia: number } {
  const partes = formateador(zona).formatToParts(new Date(ms));
  return { hora: Number(partes.find((p) => p.type === 'hour')?.value ?? 0) % 24, dia: Math.max(0, DIAS_SEMANA.indexOf(partes.find((p) => p.type === 'weekday')?.value ?? 'Sun')) };
}
const enRango = (h: number, desde: number, hasta: number) => (desde === hasta ? false : desde < hasta ? h >= desde && h < hasta : h >= desde || h < hasta);
/** Cuánto ritmo admite la hora de `ms`: 0 en silencio, `trabajo.peso` mientras la persona trabaja, 1 el resto. */
export function pesoHora(h: Horario, ms: number): number {
  if (!h.silencio && !h.trabajo) return 1;
  const { hora, dia } = horaLocal(h.zona, ms);
  if (h.silencio && enRango(hora, h.silencio.desde, h.silencio.hasta)) return 0;
  if (h.trabajo && h.trabajo.dias.includes(dia) && enRango(hora, h.trabajo.desde, h.trabajo.hasta)) return h.trabajo.peso;
  return 1;
}
/** Horas «útiles» entre `a` y `b`: cada hora pesa lo que dice `pesoHora` (sin horario, las horas naturales). */
export function tiempoPonderado(h: Horario, a: number, b: number): number {
  if (b <= a) return 0;
  if (!h.silencio && !h.trabajo) return (b - a) / HORA;
  let total = 0, t = a;
  for (let i = 0; t < b && i < 24 * 400; i++) {
    const siguiente = Math.min(b, (Math.floor(t / HORA) + 1) * HORA);
    total += ((siguiente - t) / HORA) * pesoHora(h, (t + siguiente) / 2);
    t = siguiente;
  }
  return total;
}
/** El primer instante ≥ `ms` fuera del silencio (como mucho a 7 días: si todo es silencio, ese plazo). */
export function proximoPermitido(h: Horario, ms: number): number {
  if (pesoHora(h, ms) > 0) return ms;
  let t = (Math.floor(ms / HORA) + 1) * HORA;
  for (let i = 0; i < 24 * 7; i++, t += HORA) if (pesoHora(h, t) > 0) return t;
  return ms + 7 * DIA;
}

// ── estimador de coste ──────────────────────────────────────────────────────────────────────────
/** Inverso de la normal estándar (Acklam). */
export function zDe(p: number): number {
  const q0 = clamp(p, 1e-6, 1 - 1e-6);
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (q0 < 0.02425) { const q = Math.sqrt(-2 * Math.log(q0)); return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  if (q0 > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - q0)); return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1); }
  const q = q0 - 0.5, r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Nivel 1-5 de «level_3_intermediate», «N3», «3»… (3 si no se sabe). */
export function nivelDe(c: ClasificacionEntrada | undefined): number {
  const m = /[1-5]/.exec(String(c?.nivel_tarea ?? ''));
  return m ? Number(m[0]) : 3;
}
export const claseDe = (nivel: number, dominio: string, agente: string) => `${nivel}|${dominio || 'general'}|${agente}`;
export const claseDeTarea = (t: Pick<TareaEntrada, 'clasificacion'>, agente: string) => claseDe(nivelDe(t.clasificacion), t.clasificacion?.dominio ?? 'general', agente);

export interface Estimacion { media: number; sigma: number; p: number; /** peor caso razonable (percentil de guarda) */ pGuarda: number; n: number; fuente: 'prior' | 'mezcla' | 'observado' }
/** Coste esperado de la clase en % del plan semanal. Con poca muestra se mezcla con el prior por nivel; `peso` escala el prior (peso del modelo). */
export function estimar(est: EstadoDosificador, cfg: ConfigDosificador, clase: string, peso = 1): Estimacion {
  const E = cfg.estimador;
  // El prior se corrige con lo que ya se aprendió del agente en CUALQUIER clase (cociente real/prior): aprender una clase enseña algo de las demás.
  const calibracion = est.estimador[`*|${clase.split('|')[2] ?? ''}`];
  const factor = calibracion && calibracion.n >= 2 ? clamp(calibracion.media, 0.2, 5) : 1;
  const base = (E.prior[clase.split('|')[0] ?? ''] ?? E.costeDefectoPct) * peso;
  const e = est.estimador[clase];
  const calcular = (prior: number) => {
    let media = prior, sigma = prior * E.cvPrior, fuente: Estimacion['fuente'] = 'prior';
    if (e && e.n > 0) {
      const w = Math.min(1, e.n / E.muestraMinima);
      media = w * e.media + (1 - w) * prior;
      sigma = w < 1 ? Math.max(Math.sqrt(e.varianza), prior * E.cvPrior * (1 - w)) : Math.sqrt(e.varianza);
      fuente = w < 1 ? 'mezcla' : 'observado';
    }
    // Incertidumbre de la propia media: con pocas observaciones la clase puede estar sesgada aunque su varianza sea pequeña.
    sigma = Math.sqrt(Math.max(sigma, media * E.cvPrior * 0.4) ** 2 + (media * E.cvPrior) ** 2 / ((e?.n ?? 0) + 1));
    return { media, sigma, fuente };
  };
  const c = calcular(base * factor), z = zDe(E.percentil), zG = zDe(E.percentilGuarda);
  // El peor caso nunca baja el prior por una calibración a la baja de OTRAS clases.
  const g = factor < 1 ? calcular(base) : c;
  return { media: c.media, sigma: c.sigma, p: Math.max(0.01, c.media + z * c.sigma), pGuarda: Math.max(0.01, c.media + zG * c.sigma, g.media + zG * g.sigma), n: e?.n ?? 0, fuente: c.fuente };
}

/** Anota el coste real de una tarea terminada en su clase (EWMA de media y varianza). No muta `est`. */
export function observarClase(est: EstadoDosificador, cfg: ConfigDosificador, clase: string, costePct: number): EstadoDosificador {
  if (!fin(costePct) || costePct < 0 || costePct > 1000) return est;
  const a = cfg.estimador.alfa, e = est.estimador[clase];
  const nuevo = !e || e.n === 0 ? { n: 1, media: costePct, varianza: 0 } : (() => {
    const d = costePct - e.media, inc = a * d;
    return { n: e.n + 1, media: e.media + inc, varianza: (1 - a) * (e.varianza + d * inc) };
  })();
  // Calibración del agente: media acumulada (luego EWMA lenta) del cociente coste real / prior de su nivel.
  const [nivel = '', , agente = ''] = clase.split('|');
  const cociente = costePct / (cfg.estimador.prior[nivel] ?? cfg.estimador.costeDefectoPct), cal = est.estimador[`*|${agente}`];
  const paso = cal ? Math.max(0.1, 1 / (cal.n + 1)) : 1;
  const calNueva = { n: (cal?.n ?? 0) + 1, media: cal ? cal.media + paso * (cociente - cal.media) : cociente, varianza: 0 };
  return { ...est, estimador: { ...est.estimador, [clase]: nuevo, [`*|${agente}`]: calNueva } };
}

// ── circuito por agente y reintentos ────────────────────────────────────────────────────────────
/** Espera antes del reintento nº `intento` (1, 2…): exponencial desde `baseMin`, tope `maxMin`, con jitter ±`jitter`. `rand` inyectable. */
export function backoffMin(intento: number, cfg: ConfigDosificador, rand: () => number = Math.random): number {
  const R = cfg.reintento;
  const base = Math.min(R.maxMin, R.baseMin * 2 ** Math.max(0, Math.min(30, intento - 1)));
  return Math.min(R.maxMin, base * (1 + R.jitter * (2 * clamp(rand(), 0, 1) - 1)));
}
/** Hasta cuándo está abierto el circuito del agente (ms), o null si está cerrado. */
export function circuitoAbierto(est: EstadoDosificador, agente: string, ahora: number): number | null {
  const h = est.circuitos[agente]?.abiertoHasta ?? null;
  return h !== null && ahora < h ? h : null;
}
/**
 * Un agente topó con su límite. Tras `umbralLimites` límites en la misma ventana el circuito se abre HASTA `resetsAt` (cuando el
 * proveedor lo dice y está en el futuro); sin esa fecha no se sabe cuándo, y solo entonces se usa el backoff exponencial.
 */
export function registrarLimite(est: EstadoDosificador, cfg: ConfigDosificador, agente: string, resetsAt: number | null, ahora: number, rand: () => number = Math.random): EstadoDosificador {
  const previo = est.circuitos[agente];
  const vigente = previo && (previo.ventana === null || ahora < previo.ventana) ? previo : { limites: 0, abiertoHasta: null, ventana: null };
  const limites = vigente.limites + 1;
  const futuro = resetsAt !== null && resetsAt > ahora ? resetsAt : null;
  const abre = limites >= cfg.circuito.umbralLimites;
  const hasta = !abre ? vigente.abiertoHasta : futuro ?? ahora + backoffMin(limites, cfg, rand) * MIN;
  return { ...est, circuitos: { ...est.circuitos, [agente]: { limites, abiertoHasta: hasta, ventana: futuro ?? vigente.ventana } } };
}
/** Una tarea terminó: su coste real alimenta al estimador, su lease se libera y el gasto cuenta como de agentes (no personal). */
export function registrarCoste(est: EstadoDosificador, cfg: ConfigDosificador, o: { tarea?: string; agente: string; clase?: string; costePct?: number | null }): EstadoDosificador {
  let r = est;
  if (o.clase && fin(o.costePct)) r = observarClase(r, cfg, o.clase, o.costePct);
  if (fin(o.costePct) && o.costePct > 0) r = { ...r, gasto: { ...r.gasto, [o.agente]: (r.gasto[o.agente] ?? 0) + o.costePct } };
  if (o.tarea && r.leases[o.tarea]) { const { [o.tarea]: _quitada, ...resto } = r.leases; r = { ...r, leases: resto }; }
  return r;
}

// ── pacer ───────────────────────────────────────────────────────────────────────────────────────
/** Reserva personal AHORA, en % del plan: lo que la persona aún gastará hasta el reinicio. */
export function reservaPersonal(cfg: ConfigDosificador, personal: { media: number; varianza: number; n: number } | undefined, fraccionRestante: number, diasRestantes: number): number {
  const R = cfg.reserva;
  if (R.modo === 'fijo') return R.fijaPct * clamp(fraccionRestante, 0, 1);
  const p = personal && personal.n >= 2 ? personal.media + zDe(R.percentil) * Math.sqrt(personal.varianza) : R.fijaPct / 7;
  return Math.max(R.minimoPctDia, p) * Math.max(0, diasRestantes);
}

export interface Pacing {
  techoPct: number; presupuestoPct: number; lineaPct: number | null; errorPct: number | null; tasaIdealPorHora: number | null;
  /** Retraso que pide el controlador P (min), antes de la banda muerta y la histéresis; 0 sin fecha de reinicio. */
  retrasoMin: number; sinFecha: boolean; fraccion: number | null;
}
/**
 * Línea ideal y controlador P de una ventana. `lineaPct` = (límite − margen)·f, con f la fracción de horas útiles ya transcurridas;
 * `errorPct` = uso − línea (positivo: vamos por delante); `retrasoMin` = clamp(kp·error/tasaIdeal, 0, retrasoMax).
 */
export function pacing(cfg: ConfigDosificador, v: VentanaCfg, o: { usadoPct: number; reinicio: number | null; ahora: number; reservaPct: number; comprometidoPct?: number }): Pacing {
  const margen = Math.min(cfg.margenSeguridadPct, v.limitePct - 0.1);
  const techo = Math.max(0, v.limitePct - margen - o.reservaPct);
  const presupuesto = Math.max(0, techo - o.usadoPct - (o.comprometidoPct ?? 0));
  if (o.reinicio === null || o.reinicio <= o.ahora) return { techoPct: techo, presupuestoPct: presupuesto, lineaPct: null, errorPct: null, tasaIdealPorHora: null, retrasoMin: 0, sinFecha: true, fraccion: null };
  const dur = v.duracionMin * MIN, inicio = o.reinicio - dur;
  const total = tiempoPonderado(cfg.horario, inicio, o.reinicio);
  const pasado = tiempoPonderado(cfg.horario, inicio, clamp(o.ahora, inicio, o.reinicio));
  const f = clamp(total > 0 ? pasado / total : (o.ahora - inicio) / dur, 0, 1);
  const linea = (v.limitePct - margen) * f;
  const error = o.usadoPct - linea;
  const tasa = total > 0 ? (v.limitePct - margen) / total : null;
  const retraso = cfg.pacing.modo === 'lineal_p' && error > 0 && tasa ? clamp(cfg.pacing.kp * (error / tasa) * 60, 0, cfg.pacing.retrasoMaxMin) : 0;
  return { techoPct: techo, presupuestoPct: presupuesto, lineaPct: linea, errorPct: error, tasaIdealPorHora: tasa, retrasoMin: retraso, sinFecha: false, fraccion: f };
}

/** Histéresis del modo: bloqueado manda al instante; entre normal y frenado hacen falta `ciclos` ciclos seguidos fuera de la banda. */
export function transicionModo(actual: Modo, pendiente: number, o: { bloqueado: boolean; error: number | null; banda: number; ciclos: number }): { modo: Modo; pendiente: number } {
  if (o.bloqueado) return { modo: 'bloqueado', pendiente: 0 };
  if (o.error === null) return { modo: 'frenado', pendiente: 0 };
  if (actual === 'bloqueado') return { modo: o.error > o.banda ? 'frenado' : 'normal', pendiente: 0 };
  const candidato: Modo = actual === 'normal' ? (o.error > o.banda ? 'frenado' : 'normal') : (o.error <= 0 ? 'normal' : 'frenado');
  if (candidato === actual) return { modo: actual, pendiente: 0 };
  return pendiente + 1 >= o.ciclos ? { modo: candidato, pendiente: 0 } : { modo: actual, pendiente: pendiente + 1 };
}

/** Uso/hora medido en la última jornada, sobre el último tramo sin reinicios; null con menos de media hora de datos. */
export function burnDe(muestras: { t: number; u: number }[], ahora: number): number | null {
  const recientes = muestras.filter((m) => m.t >= ahora - DIA && m.t <= ahora);
  let desde = 0;
  for (let i = 1; i < recientes.length; i++) if (recientes[i]!.u < recientes[i - 1]!.u - 0.5) desde = i;
  const tramo = recientes.slice(desde);
  if (tramo.length < 2) return null;
  const horas = (tramo[tramo.length - 1]!.t - tramo[0]!.t) / HORA;
  return horas < 0.5 ? null : Math.max(0, (tramo[tramo.length - 1]!.u - tramo[0]!.u) / horas);
}
/** Cuándo se agotará la ventana (100 %) al ritmo actual, si es antes del reinicio. */
export function agotamientoDe(usadoPct: number | null, burn: number | null, limitePct: number, reinicio: number | null, ahora: number): string | null {
  if (usadoPct === null || burn === null || burn <= 0) return null;
  if (usadoPct >= limitePct) return iso(ahora);
  const t = ahora + ((limitePct - usadoPct) / burn) * HORA;
  return reinicio !== null && t >= reinicio ? null : iso(t);
}

// ── decisión ────────────────────────────────────────────────────────────────────────────────────
interface Prep {
  agente: string; datos: EstadoDato; sem: VentanaCfg; ses: VentanaCfg | null;
  U: number | null; Us: number | null; R: number | null; Rs: number | null; sinFecha: boolean;
  reserva: number; pac: Pacing | null; modo: Modo; tasa: number | null; capacidad: number; escala: number; topeSesion: number | null;
}

function reinicioDe(v: VentanaCfg, observado: number | null, ahora: number): { reinicio: number | null; pasado: boolean } {
  if (observado !== null && observado > ahora) return { reinicio: observado, pasado: false };
  const ancla = v.anclaRenovacion ? Date.parse(v.anclaRenovacion) : Number.NaN;
  if (v.tipo === 'fija' && Number.isFinite(ancla)) {
    const dur = v.duracionMin * MIN;
    return { reinicio: ancla > ahora ? ancla : ancla + Math.ceil((ahora - ancla + 1) / dur) * dur, pasado: false };
  }
  return { reinicio: null, pasado: observado !== null };
}

function preparar(a: string, entrada: EntradaDosificador, cfg: ConfigDosificador, est: EstadoDosificador, inflight: number): Prep {
  const ahora = entrada.ahora;
  const vs = [...cfg.planes[a]!.ventanas].sort((x, y) => y.duracionMin - x.duracionMin);
  const sem = vs[0]!, ses = vs.length > 1 ? vs[vs.length - 1]! : null;
  const leidoMs = entrada.leido ? Date.parse(entrada.leido) : null;
  const cuota = cuotaDeUso(a, entrada.uso[a], leidoMs !== null && Number.isFinite(leidoMs) ? leidoMs : null);
  const vSem = ventanaDe(cuota, 'semanal'), vSes = ventanaDe(cuota, 'sesion');
  let datos = estadoCuota(cuota, ahora, cfg.sonda.caducidadMin);
  let U = vSem?.usadoPct ?? null, Us = vSes?.usadoPct ?? null;
  const r = reinicioDe(sem, vSem?.reinicio ?? null, ahora);
  if (datos === 'ok' && r.pasado) datos = 'caduca'; // el reinicio ya pasó: la lectura es de la ventana anterior
  if (cfg.modoSimulacion && datos !== 'ok') { U = U ?? 0; Us = Us ?? 0; }
  const rs = ses ? reinicioDe(ses, vSes?.reinicio ?? null, ahora) : { reinicio: null, pasado: false };
  const R = r.reinicio, durSem = sem.duracionMin * MIN;
  const frac = R !== null ? clamp((R - ahora) / durSem, 0, 1) : 1;
  const reserva = U === null ? 0 : Math.min(reservaPersonal(cfg, est.personal[a], frac, R !== null ? (R - ahora) / DIA : durSem / DIA), Math.max(0, sem.limitePct - cfg.margenSeguridadPct));
  const pac = U === null ? null : pacing(cfg, sem, { usadoPct: U, reinicio: R, ahora, reservaPct: reserva, comprometidoPct: inflight });
  // Ritmo al que se repone el presupuesto: lo que queda, repartido en las horas útiles hasta el reinicio (o la ventana entera sin fecha).
  let tasa: number | null = null;
  if (pac) {
    const horas = R !== null ? tiempoPonderado(cfg.horario, ahora, R) : durSem / HORA;
    tasa = horas > 0 ? pac.presupuestoPct / horas : 0;
  }
  return {
    agente: a, datos, sem, ses, U, Us, R, Rs: rs.reinicio, sinFecha: R === null, reserva, pac, modo: est.modos[a]?.modo ?? 'normal', tasa,
    capacidad: cfg.pacing.maxRafagaPct, escala: ses?.escalaCoste ?? 1, topeSesion: ses ? ses.limitePct - cfg.margen5hPct : null,
  };
}

const inflightDe = (est: EstadoDosificador, a: string) => Object.values(est.leases).reduce((s, l) => (l.agente === a ? s + l.costePct : s), 0);

/** Decide qué tareas se lanzan, dónde y cuándo. Pura: no muta `previo`; devuelve el estado nuevo. */
export function decidir(entrada: EntradaDosificador, cfg: ConfigDosificador = CONFIG_BASE, previo?: EstadoDosificador | null): Resultado {
  const ahora = entrada.ahora;
  const est: EstadoDosificador = previo ? normalizarEstado(JSON.parse(JSON.stringify(previo))) : estadoInicial();
  const agentesCfg = Object.keys(cfg.planes);

  // Lo caducado: leases vencidos y circuitos que llegaron a su reinicio.
  for (const [id, l] of Object.entries(est.leases)) if (l.hasta <= ahora) delete est.leases[id];
  for (const c of Object.values(est.circuitos)) {
    if (c.abiertoHasta !== null && ahora >= c.abiertoHasta) { c.abiertoHasta = null; if (c.ventana !== null && ahora >= c.ventana) { c.limites = 0; c.ventana = null; } }
    else if (c.abiertoHasta === null && c.ventana !== null && ahora >= c.ventana) { c.limites = 0; c.ventana = null; }
  }

  // Por agente: lectura de la cuota, pacing, modo (con histéresis), cubo de fichas, muestras y perfil personal.
  const prep: Record<string, Prep> = {};
  const agentes: Record<string, InfoAgente> = {};
  for (const a of agentesCfg) {
    const p = preparar(a, entrada, cfg, est, inflightDe(est, a));
    prep[a] = p;
    if (p.U !== null && p.datos === 'ok') {
      // muestras para el burn rate
      const ms = (est.muestras[a] ??= []);
      const ult = ms[ms.length - 1];
      if (ult && p.U < ult.u - 0.5) est.muestras[a] = [];
      est.muestras[a] = est.muestras[a]!.filter((m) => m.t >= ahora - 26 * HORA);
      const ult2 = est.muestras[a]![est.muestras[a]!.length - 1];
      if (!ult2 || ahora - ult2.t >= 5 * MIN) est.muestras[a]!.push({ t: ahora, u: p.U });
      // perfil personal: lo que sube el uso y no es de las tareas de los agentes (en %/día)
      const ref = est.ref[a];
      if (!ref || p.U < ref.u - 0.5 || ahora < ref.t) { est.ref[a] = { t: ahora, u: p.U }; est.gasto[a] = 0; }
      else if (ahora - ref.t >= HORA) {
        const personal = Math.max(0, p.U - ref.u - (est.gasto[a] ?? 0)), tasaDia = personal / ((ahora - ref.t) / DIA);
        const pr = est.personal[a] ?? { media: tasaDia, varianza: 0, n: 0 }, al = cfg.reserva.alfa;
        if (pr.n === 0) est.personal[a] = { media: tasaDia, varianza: 0, n: 1 };
        else { const d = tasaDia - pr.media, inc = al * d; est.personal[a] = { media: pr.media + inc, varianza: (1 - al) * (pr.varianza + d * inc), n: pr.n + 1 }; }
        est.ref[a] = { t: ahora, u: p.U }; est.gasto[a] = 0;
      }
    }
    // modo
    const m = est.modos[a] ?? { modo: 'normal' as Modo, pendiente: 0, cambios: 0 };
    if (p.pac && (p.datos === 'ok' || cfg.modoSimulacion)) {
      const bloqueado = p.U! >= p.pac.techoPct;
      const t = transicionModo(m.modo, m.pendiente, { bloqueado, error: cfg.pacing.modo === 'asap' ? 0 : p.pac.errorPct, banda: cfg.pacing.bandaMuertaPct, ciclos: cfg.pacing.histeresisCiclos });
      est.modos[a] = { modo: t.modo, pendiente: t.pendiente, cambios: m.cambios + (t.modo !== m.modo ? 1 : 0) };
    } else est.modos[a] = m;
    p.modo = est.modos[a]!.modo;
    // cubo de fichas: se repone al ritmo del presupuesto restante, hasta `maxRafagaPct`
    const cubo = est.buckets[a] ?? { nivel: p.capacidad, t: ahora };
    if (p.tasa !== null && ahora > cubo.t) cubo.nivel = Math.min(p.capacidad, cubo.nivel + p.tasa * tiempoPonderado(cfg.horario, cubo.t, ahora));
    cubo.nivel = Math.min(p.capacidad, cubo.nivel);
    cubo.t = ahora;
    est.buckets[a] = cubo;
  }

  const asignadasAgente: Record<string, number> = {}, asignadasEquipo: Record<string, number> = {}, sinCabida: Record<string, boolean> = {};
  const decisiones: Decision[] = [], diferidas: Diferida[] = [];
  const quien = (eq: string, a: string) => `${eq}|${a}`;

  const comprometido = (a: string) => inflightDe(est, a);
  const hueco = (a: string) => (cfg.concurrencia.porAgente[a] ?? 1) - (entrada.agentes[a]?.enCurso ?? 0) - (asignadasAgente[a] ?? 0);
  const elegirEquipo = (t: TareaEntrada, a: string) => {
    let mejor: EquipoEntrada | null = null, puntos = -Infinity;
    for (const e of entrada.equipos) {
      const n = asignadasEquipo[quien(e.id, a)] ?? 0;
      if (!e.disponible || n >= 1 || (e.enCurso[a] ?? 0) + n >= cfg.concurrencia.porEquipo) continue;
      const carga = Object.values(e.enCurso).reduce((s, x) => s + x, 0) + Object.entries(asignadasEquipo).reduce((s, [k, x]) => (k.startsWith(`${e.id}|`) ? s + x : s), 0);
      const p = (t.equipo === e.id ? cfg.afinidad.pesoEquipoPreferido : 0) + (t.repo && e.repos.includes(t.repo) ? cfg.afinidad.pesoRepo : 0) - carga;
      if (p > puntos || (p === puntos && mejor !== null && e.id < mejor.id)) { mejor = e; puntos = p; }
    }
    return mejor;
  };

  type Fallo = { ok: false; motivo: string; hasta: number | null };
  type Bien = { ok: true; eq: EquipoEntrada; clase: string; costePct: number; peor: number; lanzarEn: number | null; motivo: string; fichas: number };
  const evaluar = (t: TareaEntrada, a: string): Fallo | Bien => {
    const p = prep[a]!, ag = entrada.agentes[a];
    const no = (motivo: string, hasta: number | null = null): Fallo => ({ ok: false, motivo: `${a}: ${motivo}`, hasta });
    if (!ag || !ag.disponible) return no('agente no disponible');
    const cierre = circuitoAbierto(est, a, ahora);
    if (cierre !== null) return no(`circuito abierto (límite alcanzado) hasta ${iso(cierre)}`, cierre);
    if (hueco(a) <= 0) return no('sin hueco de concurrencia');
    const eq = elegirEquipo(t, a);
    if (!eq) return no('ningún equipo libre');
    if (!cfg.modoSimulacion && p.datos !== 'ok') return no(p.datos === 'ausente' ? 'sin dato de cuota (no se lanza a ciegas)' : 'dato de cuota caduco (no se lanza a ciegas)');
    if (pesoHora(cfg.horario, ahora) === 0) { const h = proximoPermitido(cfg.horario, ahora); return no(`horario de silencio hasta ${iso(h)}`, h); }
    const modelo = t.modelo ? cfg.planes[a]!.pesosModelo[t.modelo] ?? 1 : 1;
    const e = estimar(est, cfg, claseDeTarea(t, a), modelo);
    const c = e.p, infl = comprometido(a);
    let motivo = `${a} en ${eq.id}: p80 ${pct1(c)} %`;
    // ventana de 5 h
    if (p.Us !== null && p.topeSesion !== null && p.Us + p.escala * (infl + c) > p.topeSesion) {
      return no(`la ventana de 5 h (${pct1(p.Us)} % + ${pct1(p.escala * c)} %) pasaría de ${pct1(p.topeSesion)} %; espera al reinicio`, p.Rs !== null && p.Rs > ahora ? p.Rs : null);
    }
    if (!p.pac || p.U === null) return { ok: true, eq, clase: claseDeTarea(t, a), costePct: c, peor: e.pGuarda, lanzarEn: null, motivo: `${motivo}; sin % semanal: solo rige la ventana de 5 h`, fichas: 0 };
    if (p.U >= p.pac.techoPct) return no(`cuota semanal agotada para dosificar (${pct1(p.U)} % ≥ techo ${pct1(p.pac.techoPct)} %) hasta el reinicio`, p.R);
    if (!cfg.cola.backfill && sinCabida[a]) return no('cola estricta: la tarea anterior no cabe y no se salta');
    const libre = p.pac.techoPct - p.U - infl;
    // La guarda: aunque la tarea cueste lo peor que cabe esperar, la ventana no se come el margen de seguridad.
    const guarda = p.sem.limitePct - cfg.margenSeguridadPct;
    if (p.U + infl + e.pGuarda + p.reserva > guarda && c <= libre) { sinCabida[a] = true; return no(`guarda: en el peor caso (${pct1(e.pGuarda)} %) pasaría de ${pct1(guarda)} %`); }
    if (c > libre) { sinCabida[a] = true; return no(`no cabe: p80 ${pct1(c)} % > presupuesto libre ${pct1(Math.max(0, libre))} % (techo ${pct1(p.pac.techoPct)} %, uso ${pct1(p.U)} %, en vuelo ${pct1(infl)} %)`); }
    // ritmo: controlador P (solo en modo frenado) y cubo de fichas
    let esperaMs = 0, fichas = 0;
    if (cfg.pacing.modo === 'lineal_p') {
      const retrasoP = p.modo === 'frenado' ? p.pac.retrasoMin * MIN : 0;
      const gasto = Math.min(e.media, p.capacidad), nivel = est.buckets[a]!.nivel - gasto;
      let esperaCubo = 0;
      if (nivel < 0) {
        if (!p.tasa || p.tasa <= 0) return no('sin presupuesto por unidad de tiempo');
        esperaCubo = (-nivel / p.tasa) * HORA;
      }
      esperaMs = Math.max(retrasoP, esperaCubo);
      fichas = gasto;
      if (esperaMs > cfg.pacing.retrasoMaxMin * MIN) return no(`ritmo: toca esperar ${Math.round(esperaMs / MIN)} min (máximo ${cfg.pacing.retrasoMaxMin} min)`, ahora + Math.round(esperaMs));
      motivo += p.modo === 'frenado' ? `; frenado: ${pct1(p.pac.errorPct ?? 0)} % por delante de la línea` : `; por ${p.pac.errorPct !== null && p.pac.errorPct < 0 ? 'detrás de' : 'sobre'} la línea`;
    }
    let lanzar: number | null = null;
    if (esperaMs > 0) lanzar = proximoPermitido(cfg.horario, ahora + Math.round(esperaMs));
    return { ok: true, eq, clase: claseDeTarea(t, a), costePct: c, peor: e.pGuarda, lanzarEn: lanzar, motivo: lanzar ? `${motivo}; en ${Math.max(1, Math.round((lanzar - ahora) / MIN))} min` : motivo, fichas };
  };

  const fijar = (t: TareaEntrada, a: string, r: Bien) => {
    asignadasAgente[a] = (asignadasAgente[a] ?? 0) + 1;
    asignadasEquipo[quien(r.eq.id, a)] = (asignadasEquipo[quien(r.eq.id, a)] ?? 0) + 1;
    est.buckets[a]!.nivel -= r.fichas;
    est.leases[t.id] = { agente: a, equipo: r.eq.id, clase: r.clase, costePct: r.costePct, peor: r.peor, lanzarEn: r.lanzarEn, hasta: Math.max(ahora, r.lanzarEn ?? ahora) + cfg.lease.ttlMin * MIN, motivo: r.motivo };
    decisiones.push({ tarea: t.id, agente: a, equipo: r.eq.id, lanzarEn: r.lanzarEn, motivo: r.motivo });
  };

  // Cola: las que aún no han empezado, por prioridad con aging; las ya decididas (lease) conservan su decisión.
  const vistos = new Set<string>();
  const cola = entrada.tareas.filter((t) => !vistos.has(t.id) && vistos.add(t.id) && (t.programada === null || t.programada <= ahora));
  const puntos = (t: TareaEntrada) => (PUNTOS_PRIORIDAD[t.prioridad] ?? PUNTOS_PRIORIDAD[cfg.cola.prioridadDefecto]) + cfg.cola.agingPorHora * (Math.max(0, ahora - t.creada) / HORA);
  cola.sort((x, y) => puntos(y) - puntos(x) || x.creada - y.creada || (x.id < y.id ? -1 : 1));
  const pendientes: TareaEntrada[] = [];
  for (const t of cola) {
    const l = est.leases[t.id];
    const a = l?.agente;
    const sigue = l && a && prep[a] && entrada.agentes[a]?.disponible && circuitoAbierto(est, a, ahora) === null && entrada.equipos.some((e) => e.id === l.equipo && e.disponible)
      && (t.agente === 'auto' || t.agente === a);
    // Antes de dejar salir una tarea ya decidida se vuelve a mirar la guarda: durante la espera el uso pudo subir.
    const pa = a ? prep[a] : undefined;
    const sigueSegura = !(sigue && l && pa?.U != null && (l.lanzarEn === null || l.lanzarEn <= ahora)
      && pa.U + comprometido(a!) - l.costePct + l.peor + pa.reserva > pa.sem.limitePct - cfg.margenSeguridadPct);
    if (l && a && sigue && sigueSegura) {
      asignadasAgente[a] = (asignadasAgente[a] ?? 0) + 1;
      asignadasEquipo[quien(l.equipo, a)] = (asignadasEquipo[quien(l.equipo, a)] ?? 0) + 1;
      decisiones.push({ tarea: t.id, agente: a, equipo: l.equipo, lanzarEn: l.lanzarEn !== null && l.lanzarEn > ahora ? l.lanzarEn : null, motivo: l.motivo });
    } else { if (l) delete est.leases[t.id]; pendientes.push(t); }
  }

  for (const t of pendientes) {
    const fijo = t.agente !== 'auto';
    let candidatos: string[] = fijo ? [t.agente] : agentesCfg.filter((a) => entrada.agentes[a] !== undefined);
    if (!fijo) {
      const tipo = cfg.afinidad.agentePorTipo[t.clasificacion?.intencion ?? ''] ?? cfg.afinidad.agentePorTipo[t.clasificacion?.dominio ?? ''];
      const rel = (a: string) => { const p = prep[a]!; return p.pac && p.U !== null ? (p.pac.techoPct - p.U - comprometido(a)) / Math.max(1, p.pac.techoPct) : -1; };
      candidatos.sort((x, y) => (x === tipo ? -1 : 0) - (y === tipo ? -1 : 0) || rel(y) - rel(x) || (x < y ? -1 : 1));
    }
    if (!candidatos.length) { diferidas.push({ tarea: t.id, hasta: null, motivo: 'ningún agente configurado está en la entrada' }); continue; }
    const fallos: Fallo[] = [];
    let colocada = false;
    for (const a of candidatos) {
      if (!prep[a]) { fallos.push({ ok: false, motivo: `${a}: agente sin plan configurado`, hasta: null }); continue; }
      const r = evaluar(t, a);
      if (r.ok) { fijar(t, a, r); colocada = true; break; }
      fallos.push(r);
    }
    if (!colocada) {
      const conFecha = fallos.map((f) => f.hasta).filter((h): h is number => h !== null);
      diferidas.push({ tarea: t.id, hasta: fallos.every((f) => f.hasta !== null) ? Math.min(...conFecha) : null, motivo: fallos.map((f) => f.motivo).slice(0, 2).join('; ') });
    }
  }

  // Resumen para el monitor.
  let burnMax: number | null = null, agota: string | null = null;
  for (const a of agentesCfg) {
    const p = prep[a]!, m = est.modos[a]!;
    const burn = burnDe(est.muestras[a] ?? [], ahora);
    const ag = agotamientoDe(p.U, burn, p.sem.limitePct, p.R, ahora);
    if (burn !== null && (burnMax === null || burn > burnMax)) burnMax = burn;
    if (ag !== null && (agota === null || ag < agota)) agota = ag;
    agentes[a] = {
      datos: p.datos, disponible: entrada.agentes[a]?.disponible ?? false, usadoPct: p.U, usadoSesionPct: p.Us, reinicio: p.R, reinicioSesion: p.Rs, limitePct: p.sem.limitePct,
      techoPct: p.pac?.techoPct ?? null, presupuestoPct: p.pac ? Math.max(0, p.pac.techoPct - (p.U ?? 0) - comprometido(a)) : null, comprometidoPct: comprometido(a), reservaPct: p.reserva,
      lineaPct: p.pac?.lineaPct ?? null, errorPct: p.pac?.errorPct ?? null, modo: m.modo, retrasoMin: p.pac?.retrasoMin ?? 0, tasaPorHora: p.tasa, burn, agotamiento: ag,
      circuitoHasta: circuitoAbierto(est, a, ahora), sinFecha: p.sinFecha, fichas: est.buckets[a]?.nivel ?? null,
    };
  }
  const conDato = agentesCfg.filter((a) => entrada.agentes[a] !== undefined && agentes[a]!.usadoPct !== null);
  const modos = conDato.map((a) => agentes[a]!.modo);
  const modo: Modo = conDato.length && modos.every((m) => m === 'bloqueado') ? 'bloqueado' : modos.some((m) => m !== 'normal') ? 'frenado' : 'normal';
  est.ultima = { en: ahora, decisiones: decisiones.length, diferidas: diferidas.length };
  return {
    decisiones, diferidas: diferidas.slice(0, 200), estado: est, agentes,
    resumen: { modo, burn: burnMax === null ? null : Math.round(burnMax * 1000) / 1000, agotamiento: agota, circuitos: Object.fromEntries(agentesCfg.map((a) => [a, circuitoAbierto(est, a, ahora) !== null])) },
  };
}
