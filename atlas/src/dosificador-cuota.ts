/**
 * Sondas de cuota del dosificador: leen lo que dicen las CLIs de Claude y Codex (o el `limites-plan.json` de Atlas dev) y lo dejan
 * en una forma única, `Cuota`: por ventana, el % usado y el instante del reinicio. Lo único fiable de las fuentes es eso, así que
 * los parsers son TOLERANTES y nunca lanzan: porcentaje 0-100 o fracción 0-1, `resets_at` en segundos, milisegundos o ISO,
 * `used_percent` o `usedPercent`, y la ventana se reconoce por su duración (`window_minutes` ~300 / ~10080), no por su posición
 * (`primary`/`secondary`). Un campo ausente es `null`; el dosificador decide qué hace con un dato ausente (fail-closed).
 */
export interface VentanaUso { nombre: string; usadoPct: number | null; /** ms desde la época */ reinicio: number | null; minutos?: number | null }
export interface Cuota { agente: string; ventanas: VentanaUso[]; /** ms desde la época del momento en que se leyó, o null si se ignora */ leido: number | null; plan?: string | null; fuente?: string | null }

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);
const numero = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v.trim().replace('%', '').replace(',', '.')); return Number.isFinite(n) ? n : null; }
  return null;
};

/** Un instante en segundos, milisegundos (épocas) o ISO → ms; lo que no sea una fecha, null. */
export function tiempoMs(v: unknown): number | null {
  const n = typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
  if (typeof n === 'number') return Number.isFinite(n) && n > 0 ? (n < 1e11 ? Math.round(n * 1000) : Math.round(n)) : null;
  if (typeof n === 'string') { const t = Date.parse(n); return Number.isFinite(t) && t > 0 ? t : null; }
  return null;
}

const CLAVES_PCT = ['used_percent', 'usedPercent', 'used_percentage', 'usedPercentage', 'percent_used', 'percentUsed', 'usage_percent', 'usagePercent', 'utilization', 'used_fraction', 'usedFraction', 'used_ratio', 'usedRatio', 'used', 'usage', 'percent', 'pct'];
const CLAVES_MIN = ['window_minutes', 'windowMinutes', 'windowDurationMins', 'window_duration_mins', 'window_duration_minutes', 'windowDurationMinutes'];
const CLAVES_SEG = ['window_seconds', 'windowSeconds', 'limit_window_seconds', 'limitWindowSeconds', 'window_duration_seconds'];
const CLAVES_RESET = ['resets_at', 'resetsAt', 'reset_at', 'resetAt', 'reset_time', 'resetTime', 'reset', 'resets', 'renews_at', 'renewsAt'];
const CLAVES_RESET_EN = ['resets_in_seconds', 'resetsInSeconds', 'reset_after_seconds', 'resetAfterSeconds', 'resets_in', 'resetsIn'];
const primera = (o: Record<string, unknown>, claves: string[]): [string, unknown] | null => { for (const k of claves) if (o[k] !== undefined && o[k] !== null) return [k, o[k]]; return null; };

interface Cruda { clave: string; pct: number | null; claveFraccion: boolean; claveAmbigua: boolean; minutos: number | null; reinicio: number | null; posicion: number }

/** Nombre de la ventana: primero por su duración, luego por el nombre de la clave y, a falta de ambas, por su posición. */
function nombreDe(c: Cruda, ventanasTotal: number): string {
  const m = c.minutos;
  if (m !== null) {
    if (Math.abs(m - 300) <= 90) return 'sesion';
    if (Math.abs(m - 10080) <= 2880) return 'semanal';
    return `ventana_${Math.round(m)}min`;
  }
  const k = c.clave.toLowerCase();
  const sufijo = /opus|sonnet|haiku|oauth|cowork|omelette|design/.exec(k)?.[0];
  if (/(five|5).?h(our)?/.test(k) || /session|sesion/.test(k)) return 'sesion';
  if (/(seven|7).?d(ay)?|week|semanal/.test(k)) return sufijo ? `semanal_${sufijo}` : 'semanal';
  if (/primary|primar/.test(k)) return ventanasTotal > 1 ? 'sesion' : 'semanal';
  if (/secondary|secundar/.test(k)) return 'semanal';
  return k.replace(/[^\w]+/g, '_').slice(0, 30) || `ventana_${c.posicion}`;
}

function recoger(nodo: unknown, clave: string, prof: number, salida: Cruda[]): void {
  const o = obj(nodo);
  if (!o || prof > 5 || salida.length > 40) return;
  const p = primera(o, CLAVES_PCT);
  const pctRaw = p ? numero(p[1]) : null;
  const reset = primera(o, CLAVES_RESET), resetEn = primera(o, CLAVES_RESET_EN);
  const sinPct = !p && CLAVES_PCT.some((k) => k in o) && (reset || primera(o, CLAVES_MIN) || primera(o, CLAVES_SEG));
  if (sinPct || (p && !obj(p[1]) && (pctRaw !== null || reset || primera(o, CLAVES_MIN) || primera(o, CLAVES_SEG)))) {
    const min = primera(o, CLAVES_MIN), seg = primera(o, CLAVES_SEG);
    const minutos = min ? numero(min[1]) : seg ? (numero(seg[1]) === null ? null : numero(seg[1])! / 60) : null;
    let reinicio = reset ? tiempoMs(reset[1]) : null;
    if (reinicio === null && resetEn && numero(resetEn[1]) !== null) reinicio = -numero(resetEn[1])! * 1000; // relativo: se resuelve con `ahora`
    salida.push({ clave, pct: pctRaw, claveFraccion: p !== null && /fraction|ratio/i.test(p[0]), claveAmbigua: p !== null && !/percent|pct/i.test(p[0]) && !/fraction|ratio/i.test(p[0]), minutos: minutos !== null && minutos > 0 ? minutos : null, reinicio, posicion: salida.length });
    return;
  }
  for (const [k, v] of Object.entries(o)) {
    if (Array.isArray(v)) v.forEach((x, i) => recoger(x, `${k}_${i}`, prof + 1, salida));
    else recoger(v, k, prof + 1, salida);
  }
}

const CONTENEDORES = /^(rate_?limits?|rateLimits(ById|ByLimitId)?|rate_limit_status|limits)$/i;
function contenedor(nodo: unknown, prof = 0): unknown {
  const o = obj(nodo);
  if (!o || prof > 5) return null;
  for (const [k, v] of Object.entries(o)) if (CONTENEDORES.test(k) && obj(v)) return v;
  for (const v of Object.values(o)) { const r = contenedor(v, prof + 1); if (r) return r; }
  return null;
}

/**
 * Lee la salida de una sonda de Claude o de Codex (cualquiera de las variantes conocidas) y la deja como `Cuota`. `ahora` fija el
 * momento de la lectura y resuelve los reinicios relativos («resets_in_seconds»).
 *
 * Porcentaje o fracción: las claves que dicen «percent/pct» son porcentajes; las de «fraction/ratio» son fracciones; las ambiguas
 * («utilization», «used») se toman por fracción si TODOS los valores del payload están en [0, 1] y alguno es fraccionario (se
 * prefiere sobrestimar el uso: es el lado seguro).
 */
export function leerCuota(agente: string, json: unknown, ahora = Date.now()): Cuota {
  const vacia: Cuota = { agente, ventanas: [], leido: ahora, plan: null, fuente: null };
  try {
    const raiz = obj(json);
    if (!raiz) return vacia;
    const crudas: Cruda[] = [];
    recoger(contenedor(raiz) ?? raiz, 'raiz', 0, crudas);
    const ambiguas = crudas.filter((c) => c.claveAmbigua && c.pct !== null);
    const ambiguasFraccion = ambiguas.length > 0 && ambiguas.every((c) => c.pct! >= 0 && c.pct! <= 1) && ambiguas.some((c) => c.pct! > 0 && c.pct! < 1);
    const vistos = new Set<string>();
    const ventanas: VentanaUso[] = [];
    for (const c of crudas) {
      const nombre = nombreDe(c, crudas.length);
      if (vistos.has(nombre)) continue; // dos descripciones de la misma ventana: vale la primera
      vistos.add(nombre);
      let pct = c.pct;
      if (pct !== null && (c.claveFraccion || (c.claveAmbigua && ambiguasFraccion))) pct *= 100;
      const reinicio = c.reinicio === null ? null : c.reinicio < 0 ? ahora + -c.reinicio : c.reinicio;
      ventanas.push({ nombre, usadoPct: pct === null || pct < 0 ? null : Math.min(100, pct), reinicio, minutos: c.minutos });
    }
    const orden = (n: string) => (n === 'sesion' ? 0 : n === 'semanal' ? 1 : 2);
    ventanas.sort((a, b) => orden(a.nombre) - orden(b.nombre));
    const plan = ['plan_type', 'planType', 'plan'].map((k) => raiz[k]).find((v) => typeof v === 'string') as string | undefined;
    return { agente, ventanas, leido: ahora, plan: plan ?? null, fuente: typeof raiz['fuente'] === 'string' ? raiz['fuente'] : null };
  } catch { return vacia; }
}
export const leerCuotaClaude = (json: unknown, ahora = Date.now()): Cuota => leerCuota('claude', json, ahora);
export const leerCuotaCodex = (json: unknown, ahora = Date.now()): Cuota => leerCuota('codex', json, ahora);

/**
 * El bloque de un agente de `limites-plan.json` de Atlas dev (`{semanal, sesion, reinicio, reinicioSesion?, plan, fuente}`) como
 * `Cuota`. `leido` es el instante de la lectura del fichero (ms), o null si se ignora. Los % se toman como porcentajes salvo que
 * todos estén en [0, 1] y alguno sea fraccionario (misma regla conservadora que `leerCuota`).
 */
export function cuotaDeUso(agente: string, uso: unknown, leido: number | null): Cuota {
  try {
    const o = obj(uso) ?? {};
    const s = numero(o['semanal']), c = numero(o['sesion']);
    const presentes = [s, c].filter((x): x is number => x !== null);
    const fraccion = presentes.length > 0 && presentes.every((x) => x >= 0 && x <= 1) && presentes.some((x) => x > 0 && x < 1);
    const pct = (x: number | null) => (x === null || x < 0 ? null : Math.min(100, fraccion ? x * 100 : x));
    const ventanas: VentanaUso[] = [
      { nombre: 'sesion', usadoPct: pct(c), reinicio: tiempoMs(o['reinicioSesion']), minutos: 300 },
      { nombre: 'semanal', usadoPct: pct(s), reinicio: tiempoMs(o['reinicio']), minutos: 10080 },
    ];
    return { agente, ventanas, leido, plan: typeof o['plan'] === 'string' ? o['plan'] : null, fuente: typeof o['fuente'] === 'string' ? o['fuente'] : null };
  } catch { return { agente, ventanas: [], leido, plan: null, fuente: null }; }
}

/** El `limites-plan.json` entero → una `Cuota` por agente. */
export function leerCuotaLimites(json: unknown, agentes: string[] = ['claude', 'codex']): Record<string, Cuota> {
  const o = obj(json) ?? {};
  const leido = typeof o['leido'] === 'string' ? Date.parse(o['leido']) : Number.NaN;
  return Object.fromEntries(agentes.map((a) => [a, cuotaDeUso(a, o[a], Number.isFinite(leido) ? leido : null)]));
}

export type EstadoDato = 'ok' | 'caduca' | 'ausente';
/** `ausente`: no hay ni un % legible; `caduca`: la lectura es más vieja que `caducidadMin`. */
export function estadoCuota(c: Cuota | null | undefined, ahora: number, caducidadMin: number): EstadoDato {
  if (!c || !c.ventanas.some((v) => v.usadoPct !== null)) return 'ausente';
  if (c.leido !== null && (ahora - c.leido > caducidadMin * 60_000 || c.leido - ahora > 5 * 60_000)) return 'caduca';
  return 'ok';
}
export const ventanaDe = (c: Cuota | null | undefined, nombre: string): VentanaUso | null => c?.ventanas.find((v) => v.nombre === nombre) ?? null;
