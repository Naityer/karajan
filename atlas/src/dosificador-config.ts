import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Configuración del dosificador, 100 % datos: planes por agente (ventanas de uso), márgenes, reserva personal, horario, pacing,
 * cola, concurrencia, afinidad, estimador, reintento, circuito, lease, sonda y modo simulación. Se guarda en
 * `<datos>/dosificador.json` con el patrón del rotador (CONFIG_BASE + lo guardado) y `normalizarConfig` NUNCA lanza: lo que no
 * entiende vuelve a su valor por defecto y los números se recortan a su rango.
 */
export type Prioridad = 'critica' | 'alta' | 'normal' | 'baja' | 'minima';
export const PRIORIDADES: Prioridad[] = ['critica', 'alta', 'normal', 'baja', 'minima'];
export const PUNTOS_PRIORIDAD: Record<Prioridad, number> = { critica: 100, alta: 75, normal: 50, baja: 25, minima: 0 };

export interface VentanaCfg {
  nombre: string;
  duracionMin: number;
  /** `rodante`: empieza con el primer uso; `fija`: se renueva en un instante fijo (ancla + k·duración). */
  tipo: 'rodante' | 'fija';
  limitePct: number;
  /** Un instante (ISO) en que la ventana `fija` se renovó o renovará: de él sale el próximo reinicio si la sonda no lo trae. */
  anclaRenovacion?: string | null;
  /** Cuántos % de ESTA ventana cuesta 1 % del plan semanal (la de 5 h es mucho más pequeña que la semanal). 1 en la mayor. */
  escalaCoste?: number;
}
export interface PlanAgente {
  ventanas: VentanaCfg[]; pesosModelo: Record<string, number>;
  /** Tope duro del % semanal que los agentes nunca pasan (reserva del total), por encima de margen y reserva. null = sin tope propio. */
  topePct?: number | null;
  /** Tasa de consumo máxima (% semanal por hora, medida con el burn rate): por encima se difiere con el motivo «ritmo». null = sin límite. */
  ritmoMaxPctHora?: number | null;
}
/** Un equipo (pc, servidor…): horas locales [desde, hasta) en que está dormido o apagado y no se le coloca ni se le activa nada. */
export interface EquipoCfg { dormido: { desde: number; hasta: number } | null }
export type PoliticaRelevo = 'primero-vivo' | 'auto' | 'preguntar';
/**
 * Relevo entre equipos: cuándo el equipo de destino (el servidor) toma una tarea que empezó otro (el PC). `primero-vivo`: al renovarse la
 * cuota la reanuda el origen si sigue dando latido; si no, la toma el destino. `auto`: siempre el destino. `preguntar`: solo si la persona
 * lo pidió. `tomarSiSilencio`: el destino también la toma si el origen deja de dar latido `silencioMin` sin haberse bloqueado.
 */
export interface RelevoCfg { politicaDefecto: PoliticaRelevo; tomarSiSilencio: boolean; silencioMin: number; graciaMin: number; maxIntentos: number }
export interface Horario {
  zona: string;
  /** Horas locales [desde, hasta) en que no se lanza nada (puede cruzar la medianoche); null = lanza a cualquier hora. */
  silencio: { desde: number; hasta: number } | null;
  /** Horas en que la persona trabaja: el dosificador cuenta con `peso` (0-1) de ritmo en ellas para dejarle cuota. null = sin distinguir. */
  trabajo: { dias: number[]; desde: number; hasta: number; peso: number } | null;
}
export interface ConfigDosificador {
  planes: Record<string, PlanAgente>;
  /** % del plan que se deja SIN usar al renovar (margen de seguridad de la ventana semanal). */
  margenSeguridadPct: number;
  /** % de la ventana de 5 h que se deja libre. */
  margen5hPct: number;
  reserva: { modo: 'fijo' | 'perfil'; fijaPct: number; percentil: number; minimoPctDia: number; alfa: number };
  horario: Horario;
  pacing: { modo: 'asap' | 'lineal_p'; kp: number; bandaMuertaPct: number; retrasoMaxMin: number; maxRafagaPct: number; histeresisCiclos: number };
  cola: { prioridadDefecto: Prioridad; agingPorHora: number; backfill: boolean };
  concurrencia: { porAgente: Record<string, number>; porEquipo: number };
  afinidad: { pesoRepo: number; pesoEquipoPreferido: number; agentePorTipo: Record<string, string> };
  estimador: { percentil: number; /** percentil de la cola con que se vigila el peor caso (la guarda) */ percentilGuarda: number; alfa: number; costeDefectoPct: number; muestraMinima: number; prior: Record<string, number>; cvPrior: number };
  reintento: { baseMin: number; maxMin: number; jitter: number };
  circuito: { umbralLimites: number };
  lease: { ttlMin: number };
  sonda: { intervaloMin: number; caducidadMin: number };
  /** Equipos con su horario de disponibilidad (por id: pc, servidor…). Un equipo que no figura está siempre disponible. */
  equipos: Record<string, EquipoCfg>;
  relevo: RelevoCfg;
  /** Con él se lanza aunque falte el dato de cuota (solo para pruebas y simulaciones). */
  modoSimulacion: boolean;
}

export const PLAN_CLAUDE: PlanAgente = {
  ventanas: [
    { nombre: 'sesion', duracionMin: 300, tipo: 'rodante', limitePct: 100, anclaRenovacion: null, escalaCoste: 6 },
    { nombre: 'semanal', duracionMin: 10080, tipo: 'fija', limitePct: 100, anclaRenovacion: null, escalaCoste: 1 },
  ],
  pesosModelo: { haiku: 0.3, sonnet: 1, opus: 5 },
  topePct: null, ritmoMaxPctHora: null,
};
export const PLAN_CODEX: PlanAgente = {
  ventanas: [
    { nombre: 'sesion', duracionMin: 300, tipo: 'rodante', limitePct: 100, anclaRenovacion: null, escalaCoste: 6 },
    { nombre: 'semanal', duracionMin: 10080, tipo: 'fija', limitePct: 100, anclaRenovacion: null, escalaCoste: 1 },
  ],
  pesosModelo: {},
  topePct: null, ritmoMaxPctHora: null,
};

export const CONFIG_BASE: ConfigDosificador = {
  planes: { claude: PLAN_CLAUDE, codex: PLAN_CODEX },
  margenSeguridadPct: 10,
  margen5hPct: 10,
  reserva: { modo: 'fijo', fijaPct: 12, percentil: 0.8, minimoPctDia: 0.5, alfa: 0.2 },
  horario: { zona: 'Europe/Madrid', silencio: null, trabajo: null },
  pacing: { modo: 'lineal_p', kp: 1, bandaMuertaPct: 3, retrasoMaxMin: 360, maxRafagaPct: 8, histeresisCiclos: 3 },
  cola: { prioridadDefecto: 'normal', agingPorHora: 5, backfill: true },
  concurrencia: { porAgente: { claude: 1, codex: 1 }, porEquipo: 1 },
  afinidad: { pesoRepo: 2, pesoEquipoPreferido: 3, agentePorTipo: {} },
  estimador: { percentil: 0.8, percentilGuarda: 0.99, alfa: 0.3, costeDefectoPct: 1, muestraMinima: 3, prior: { '1': 0.3, '2': 0.7, '3': 1.5, '4': 3, '5': 5 }, cvPrior: 0.5 },
  reintento: { baseMin: 5, maxMin: 240, jitter: 0.2 },
  circuito: { umbralLimites: 1 },
  lease: { ttlMin: 90 },
  sonda: { intervaloMin: 10, caducidadMin: 120 },
  equipos: { servidor: { dormido: { desde: 5, hasta: 8 } } },
  relevo: { politicaDefecto: 'primero-vivo', tomarSiSilencio: true, silencioMin: 45, graciaMin: 5, maxIntentos: 3 },
  modoSimulacion: false,
};

// ── normalización: nunca lanza ──────────────────────────────────────────────────────────────────
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const num = (v: unknown, def: number, min: number, max: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const ent = (v: unknown, def: number, min: number, max: number) => Math.round(num(v, def, min, max));
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
const elegir = <T extends string>(v: unknown, opciones: readonly T[], def: T): T => (typeof v === 'string' && (opciones as readonly string[]).includes(v) ? v as T : def);
const nombre = (v: unknown): string | null => (typeof v === 'string' && /^[\w.-]{1,40}$/.test(v) ? v : null);
const hora = (v: unknown, def: number) => ent(v, def, 0, 24);

function ventana(v: unknown, def: VentanaCfg): VentanaCfg {
  const o = obj(v);
  const ancla = typeof o['anclaRenovacion'] === 'string' && Number.isFinite(Date.parse(o['anclaRenovacion'])) ? o['anclaRenovacion'] : null;
  return {
    nombre: nombre(o['nombre']) ?? def.nombre, duracionMin: ent(o['duracionMin'], def.duracionMin, 1, 525_600), tipo: elegir(o['tipo'], ['rodante', 'fija'] as const, def.tipo),
    limitePct: num(o['limitePct'], def.limitePct, 1, 1000), anclaRenovacion: ancla, escalaCoste: num(o['escalaCoste'], def.escalaCoste ?? 1, 0.01, 10_000),
  };
}
function plan(v: unknown, def: PlanAgente): PlanAgente {
  const o = obj(v);
  const lista = Array.isArray(o['ventanas']) ? o['ventanas'].slice(0, 6) : [];
  const ventanas = lista.map((x, i) => ventana(x, def.ventanas[i] ?? def.ventanas[def.ventanas.length - 1] ?? PLAN_CODEX.ventanas[1]!));
  const unicas = ventanas.filter((x, i) => ventanas.findIndex((y) => y.nombre === x.nombre) === i);
  const pesos: Record<string, number> = {};
  for (const [k, p] of Object.entries(obj(o['pesosModelo'])).slice(0, 30)) if (nombre(k)) pesos[k] = num(p, 1, 0.01, 1000);
  const opcional = (k: 'topePct' | 'ritmoMaxPctHora', max: number) => (o[k] === undefined ? def[k] ?? null : o[k] === null ? null : num(o[k], def[k] ?? max, 0.1, max));
  return {
    ventanas: unicas.length ? unicas : def.ventanas.map((x) => ({ ...x })), pesosModelo: 'pesosModelo' in o ? pesos : { ...def.pesosModelo },
    topePct: opcional('topePct', 100), ritmoMaxPctHora: opcional('ritmoMaxPctHora', 100),
  };
}
function mapaNum(v: unknown, def: Record<string, number>, min: number, max: number): Record<string, number> {
  const o = obj(v);
  if (!Object.keys(o).length) return { ...def };
  const r: Record<string, number> = {};
  for (const [k, x] of Object.entries(o).slice(0, 20)) if (nombre(k)) r[k] = num(x, def[k] ?? min, min, max);
  return r;
}

export function normalizarConfig(crudo: unknown): ConfigDosificador {
  try {
    const o = obj(crudo), B = CONFIG_BASE;
    const planes: Record<string, PlanAgente> = {};
    const crudosPlanes = obj(o['planes']);
    for (const [k, def] of Object.entries(B.planes)) planes[k] = plan(crudosPlanes[k], def);
    for (const [k, v] of Object.entries(crudosPlanes).slice(0, 8)) if (nombre(k) && !planes[k]) planes[k] = plan(v, PLAN_CODEX);
    const r = obj(o['reserva']), h = obj(o['horario']), p = obj(o['pacing']), c = obj(o['cola']), cc = obj(o['concurrencia']), af = obj(o['afinidad']);
    const es = obj(o['estimador']), re = obj(o['reintento']), ci = obj(o['circuito']), le = obj(o['lease']), so = obj(o['sonda']);
    const sil = obj(h['silencio']), tra = obj(h['trabajo']);
    const zona = typeof h['zona'] === 'string' && h['zona'] ? h['zona'] : B.horario.zona;
    const silencio = h['silencio'] === undefined ? B.horario.silencio : (h['silencio'] === null || sil['desde'] === undefined || sil['hasta'] === undefined ? null : { desde: hora(sil['desde'], 0), hasta: hora(sil['hasta'], 0) });
    const trabajo = h['trabajo'] === undefined ? B.horario.trabajo : (h['trabajo'] === null || tra['desde'] === undefined || tra['hasta'] === undefined ? null
      : { dias: (Array.isArray(tra['dias']) ? tra['dias'] : [1, 2, 3, 4, 5]).map((d) => ent(d, 1, 0, 6)).slice(0, 7), desde: hora(tra['desde'], 9), hasta: hora(tra['hasta'], 18), peso: num(tra['peso'], 0.5, 0, 1) });
    const agentePorTipo: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj(af['agentePorTipo'])).slice(0, 40)) if (nombre(k) && typeof v === 'string' && nombre(v)) agentePorTipo[k] = v;
    const porAgente = mapaNum(cc['porAgente'], B.concurrencia.porAgente, 0, 20);
    for (const k of Object.keys(planes)) if (porAgente[k] === undefined) porAgente[k] = 1;
    const crudosEquipos = o['equipos'] === undefined ? B.equipos : obj(o['equipos']);
    const equipos: Record<string, EquipoCfg> = {};
    for (const [k, v] of Object.entries(crudosEquipos).slice(0, 20)) {
      if (!nombre(k)) continue;
      const d = obj(obj(v)['dormido']);
      equipos[k] = { dormido: d['desde'] === undefined || d['hasta'] === undefined ? null : { desde: hora(d['desde'], 0), hasta: hora(d['hasta'], 0) } };
    }
    const rl = obj(o['relevo']);
    return {
      planes,
      margenSeguridadPct: num(o['margenSeguridadPct'], B.margenSeguridadPct, 0, 50),
      margen5hPct: num(o['margen5hPct'], B.margen5hPct, 0, 50),
      reserva: { modo: elegir(r['modo'], ['fijo', 'perfil'] as const, B.reserva.modo), fijaPct: num(r['fijaPct'], B.reserva.fijaPct, 0, 60), percentil: num(r['percentil'], B.reserva.percentil, 0.5, 0.99), minimoPctDia: num(r['minimoPctDia'], B.reserva.minimoPctDia, 0, 20), alfa: num(r['alfa'], B.reserva.alfa, 0.01, 1) },
      horario: { zona, silencio, trabajo },
      pacing: {
        modo: elegir(p['modo'], ['asap', 'lineal_p'] as const, B.pacing.modo), kp: num(p['kp'], B.pacing.kp, 0, 20), bandaMuertaPct: num(p['bandaMuertaPct'], B.pacing.bandaMuertaPct, 0, 50),
        retrasoMaxMin: ent(p['retrasoMaxMin'], B.pacing.retrasoMaxMin, 0, 10_080), maxRafagaPct: num(p['maxRafagaPct'], B.pacing.maxRafagaPct, 0.1, 100), histeresisCiclos: ent(p['histeresisCiclos'], B.pacing.histeresisCiclos, 1, 100),
      },
      cola: { prioridadDefecto: elegir(c['prioridadDefecto'], PRIORIDADES, B.cola.prioridadDefecto), agingPorHora: num(c['agingPorHora'], B.cola.agingPorHora, 0, 100), backfill: bool(c['backfill'], B.cola.backfill) },
      concurrencia: { porAgente, porEquipo: ent(cc['porEquipo'], B.concurrencia.porEquipo, 0, 20) },
      afinidad: { pesoRepo: num(af['pesoRepo'], B.afinidad.pesoRepo, 0, 100), pesoEquipoPreferido: num(af['pesoEquipoPreferido'], B.afinidad.pesoEquipoPreferido, 0, 100), agentePorTipo },
      estimador: {
        percentil: num(es['percentil'], B.estimador.percentil, 0.5, 0.99), percentilGuarda: num(es['percentilGuarda'], B.estimador.percentilGuarda, 0.5, 0.9999), alfa: num(es['alfa'], B.estimador.alfa, 0.01, 1), costeDefectoPct: num(es['costeDefectoPct'], B.estimador.costeDefectoPct, 0.01, 50),
        muestraMinima: ent(es['muestraMinima'], B.estimador.muestraMinima, 1, 100), prior: mapaNum(es['prior'], B.estimador.prior, 0.01, 50), cvPrior: num(es['cvPrior'], B.estimador.cvPrior, 0, 3),
      },
      reintento: { baseMin: num(re['baseMin'], B.reintento.baseMin, 0.1, 1440), maxMin: num(re['maxMin'], B.reintento.maxMin, 1, 10_080), jitter: num(re['jitter'], B.reintento.jitter, 0, 1) },
      circuito: { umbralLimites: ent(ci['umbralLimites'], B.circuito.umbralLimites, 1, 50) },
      lease: { ttlMin: num(le['ttlMin'], B.lease.ttlMin, 1, 10_080) },
      sonda: { intervaloMin: num(so['intervaloMin'], B.sonda.intervaloMin, 1, 1440), caducidadMin: num(so['caducidadMin'], B.sonda.caducidadMin, 1, 10_080) },
      equipos,
      relevo: {
        politicaDefecto: elegir(rl['politicaDefecto'], ['primero-vivo', 'auto', 'preguntar'] as const, B.relevo.politicaDefecto), tomarSiSilencio: bool(rl['tomarSiSilencio'], B.relevo.tomarSiSilencio),
        silencioMin: ent(rl['silencioMin'], B.relevo.silencioMin, 5, 1440), graciaMin: ent(rl['graciaMin'], B.relevo.graciaMin, 1, 240), maxIntentos: ent(rl['maxIntentos'], B.relevo.maxIntentos, 1, 10),
      },
      modoSimulacion: bool(o['modoSimulacion'], B.modoSimulacion),
    };
  } catch { return structuredClone(CONFIG_BASE); }
}

// ── persistencia (<datos>/dosificador.json) ─────────────────────────────────────────────────────
const leerJson = (ruta: string): unknown => { try { return JSON.parse(readFileSync(ruta, 'utf8')); } catch { return null; } };
function escribirJson(ruta: string, valor: unknown): void {
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(`${ruta}.tmp`, `${JSON.stringify(valor, null, 2)}\n`, 'utf8');
  renameSync(`${ruta}.tmp`, ruta);
}

/** Los objetos se mezclan campo a campo; todo lo demás (listas, números…) lo reemplaza lo nuevo. */
export function mezclar(base: unknown, nuevo: unknown): unknown {
  if (nuevo === undefined) return base;
  if (base && nuevo && typeof base === 'object' && typeof nuevo === 'object' && !Array.isArray(base) && !Array.isArray(nuevo)) {
    const r: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(nuevo as Record<string, unknown>)) r[k] = mezclar(r[k], v);
    return r;
  }
  return nuevo;
}

/** CONFIG_BASE + lo guardado (normalizado). Sin fichero, o con uno ilegible, la base. */
export function leerConfig(ruta: string): ConfigDosificador { return normalizarConfig(existsSync(ruta) ? leerJson(ruta) : null); }
/** Mezcla `parcial` sobre lo guardado, normaliza, guarda la configuración completa y la devuelve. */
export function guardarConfig(ruta: string, parcial: unknown): ConfigDosificador {
  const cfg = normalizarConfig(mezclar(existsSync(ruta) ? leerJson(ruta) : null, parcial));
  escribirJson(ruta, cfg);
  return cfg;
}

// ── estado persistente (<datos>/dosificador-estado.json) ────────────────────────────────────────
export type Modo = 'normal' | 'frenado' | 'bloqueado';
export interface EstadoDosificador {
  version: 1;
  /** Coste en % del plan semanal por clase (nivel|dominio|agente): EWMA de media y varianza. */
  estimador: Record<string, { n: number; media: number; varianza: number }>;
  circuitos: Record<string, { limites: number; abiertoHasta: number | null; ventana: number | null }>;
  /** Tareas ya decididas y aún sin terminar: su coste p80 cuenta como comprometido hasta `hasta`. */
  leases: Record<string, { agente: string; equipo: string; clase: string; costePct: number; /** coste en el peor caso razonable (percentil de guarda) */ peor: number; lanzarEn: number | null; hasta: number; motivo: string }>;
  buckets: Record<string, { nivel: number; t: number }>;
  modos: Record<string, { modo: Modo; pendiente: number; cambios: number }>;
  muestras: Record<string, { t: number; u: number }[]>;
  personal: Record<string, { media: number; varianza: number; n: number }>;
  ref: Record<string, { t: number; u: number }>;
  gasto: Record<string, number>;
  ultima: { en: number; decisiones: number; diferidas: number } | null;
  /** Las últimas decisiones de relevo (las 200 más recientes), para el monitor. */
  relevos: RegistroRelevo[];
}
export interface RegistroRelevo { en: number; relevo: string; equipo: string; accion: 'tomar' | 'esperar' | 'ceder'; agente: string | null; lanzarEn: number | null; motivo: string }
export const MAX_REGISTRO_RELEVOS = 200;
export const estadoInicial = (): EstadoDosificador => ({ version: 1, estimador: {}, circuitos: {}, leases: {}, buckets: {}, modos: {}, muestras: {}, personal: {}, ref: {}, gasto: {}, ultima: null, relevos: [] });

const fin = (v: unknown, def: number) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const finN = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Estado tolerante: lo ilegible o ausente vuelve a vacío; nunca lanza. */
export function normalizarEstado(crudo: unknown): EstadoDosificador {
  const e = estadoInicial();
  try {
    const o = obj(crudo);
    for (const [k, v] of Object.entries(obj(o['estimador'])).slice(0, 500)) { const x = obj(v); e.estimador[k] = { n: ent(x['n'], 0, 0, 1e9), media: fin(x['media'], 0), varianza: Math.max(0, fin(x['varianza'], 0)) }; }
    for (const [k, v] of Object.entries(obj(o['circuitos'])).slice(0, 20)) { const x = obj(v); e.circuitos[k] = { limites: ent(x['limites'], 0, 0, 1e6), abiertoHasta: finN(x['abiertoHasta']), ventana: finN(x['ventana']) }; }
    for (const [k, v] of Object.entries(obj(o['leases'])).slice(0, 500)) {
      const x = obj(v);
      if (typeof x['agente'] === 'string' && typeof x['equipo'] === 'string') e.leases[k] = { agente: x['agente'], equipo: x['equipo'], clase: typeof x['clase'] === 'string' ? x['clase'].slice(0, 120) : '', costePct: Math.max(0, fin(x['costePct'], 0)), peor: Math.max(0, fin(x['peor'], fin(x['costePct'], 0))), lanzarEn: finN(x['lanzarEn']), hasta: fin(x['hasta'], 0), motivo: typeof x['motivo'] === 'string' ? x['motivo'].slice(0, 300) : '' };
    }
    for (const [k, v] of Object.entries(obj(o['buckets'])).slice(0, 20)) { const x = obj(v); e.buckets[k] = { nivel: fin(x['nivel'], 0), t: fin(x['t'], 0) }; }
    for (const [k, v] of Object.entries(obj(o['modos'])).slice(0, 20)) { const x = obj(v); e.modos[k] = { modo: elegir(x['modo'], ['normal', 'frenado', 'bloqueado'] as const, 'normal'), pendiente: ent(x['pendiente'], 0, 0, 1e6), cambios: ent(x['cambios'], 0, 0, 1e9) }; }
    for (const [k, v] of Object.entries(obj(o['muestras'])).slice(0, 20)) {
      if (Array.isArray(v)) e.muestras[k] = v.slice(-600).map((m) => obj(m)).filter((m) => finN(m['t']) !== null && finN(m['u']) !== null).map((m) => ({ t: m['t'] as number, u: m['u'] as number }));
    }
    for (const [k, v] of Object.entries(obj(o['personal'])).slice(0, 20)) { const x = obj(v); e.personal[k] = { media: fin(x['media'], 0), varianza: Math.max(0, fin(x['varianza'], 0)), n: ent(x['n'], 0, 0, 1e9) }; }
    for (const [k, v] of Object.entries(obj(o['ref'])).slice(0, 20)) { const x = obj(v); if (finN(x['t']) !== null && finN(x['u']) !== null) e.ref[k] = { t: x['t'] as number, u: x['u'] as number }; }
    for (const [k, v] of Object.entries(obj(o['gasto'])).slice(0, 20)) e.gasto[k] = Math.max(0, fin(v, 0));
    const u = obj(o['ultima']);
    if (finN(u['en']) !== null) e.ultima = { en: u['en'] as number, decisiones: ent(u['decisiones'], 0, 0, 1e6), diferidas: ent(u['diferidas'], 0, 0, 1e6) };
    if (Array.isArray(o['relevos'])) {
      e.relevos = o['relevos'].map((x) => obj(x)).filter((x) => finN(x['en']) !== null && typeof x['relevo'] === 'string').slice(-MAX_REGISTRO_RELEVOS).map((x) => ({
        en: x['en'] as number, relevo: (x['relevo'] as string).slice(0, 80), equipo: typeof x['equipo'] === 'string' ? x['equipo'].slice(0, 80) : '',
        accion: elegir(x['accion'], ['tomar', 'esperar', 'ceder'] as const, 'esperar'), agente: typeof x['agente'] === 'string' ? x['agente'] : null, lanzarEn: finN(x['lanzarEn']), motivo: typeof x['motivo'] === 'string' ? x['motivo'].slice(0, 300) : '',
      }));
    }
  } catch { return estadoInicial(); }
  return e;
}
export const leerEstado = (ruta: string): EstadoDosificador => normalizarEstado(existsSync(ruta) ? leerJson(ruta) : null);
export const guardarEstado = (ruta: string, e: EstadoDosificador): void => escribirJson(ruta, e);
