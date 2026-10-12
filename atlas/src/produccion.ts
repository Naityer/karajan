import { formatear, redondear } from './redondeo';

/**
 * Port 1:1 de `app/analytics/produccion.py` (acierto, flujo, eficiencia, matriz de skills y «qué mejorar»): mismas reglas,
 * mismos redondeos y mismo orden. Las fixtures de paridad (tests/fixtures/produccion.json) las genera el Python.
 *
 * Acierto por tarea (0–1): 0,5 sin re-trabajo (que en 24 h no llegue otro prompt que cite el anterior, nombre los mismos
 * ficheros o componentes, o pida corregir lo mismo), 0,2 completada sin error, 0,2 validación aprobada y 0,1 sin revisión
 * humana bloqueante; la señal que falta reparte su peso. Lo revisado en la nota del baúl manda sobre lo clasificado.
 */
export interface RunAnalitica { provider_name?: string | null; status?: string; latency_ms?: number | null; estimated_cost_usd?: number | null; error?: string | null }
export interface TareaAnalitica {
  task_id: string; prompt: string; status: string; created_at: string; entry_agent?: string | null; classified_by?: string | null; nivel?: string | null;
  dominios?: string[]; intencion?: string | null; recomendadas?: string[]; ejecutadas?: string[]; runs?: RunAnalitica[]; decisiones?: string[];
  revision?: Record<string, string[]>;
}
export interface SkillCatalogo { nombre: string; descripcion?: string; instalada?: boolean }
export interface Acierto { score: number; senales: Record<string, number>; retrabajo: string | null; repetida_por: string | null }

const PESOS: Record<string, number> = { retrabajo: 0.5, completada: 0.2, validacion: 0.2, revision: 0.1 };
const VENTANA_MS = 24 * 3600 * 1000;
const CORRECCION = [
  'arregla', 'corrige', 'sigue sin', 'sigue igual', 'sigue apareciendo', 'otra vez', 'de nuevo', 'no funciona', 'no va ',
  'todavia', 'aun no', 'falla', 'vuelve a', 'revisa otra', 'fix ', 'still', 'again', 'broken', "doesn't work", 'not working',
];
const RUTA = /[a-z0-9_./-]+\.(?:tsx|ts|jsx|js|py|css|md|json|html|sql|yml|yaml)\b/g;
const COMPONENTE = /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g;
const CATEGORIAS_SKILL: [string, string[]][] = [
  ['interfaz', ['frontend', 'ui', 'ux', 'design', 'diseno', 'taste', 'visual', 'css', 'animation', 'brand', 'theme', 'minimalist', 'brutalist', 'impeccable', 'image-to-code', 'imagegen']],
  ['backend', ['backend', 'api', 'mcp', 'server', 'database', 'sql']],
  ['seguridad', ['security', 'seguridad', 'cti', 'threat', 'secret']],
  ['documentos', ['docx', 'pdf', 'pptx', 'xlsx', 'doc-', 'markdown', 'markitdown', 'latex', 'report', 'comms', 'slides', 'poster']],
  ['datos', ['data', 'pandas', 'polars', 'dask', 'plot', 'matplotlib', 'seaborn', 'statistic', 'visualization', 'scikit', 'vaex']],
  ['investigacion', ['research', 'paper', 'literature', 'citation', 'review', 'scholar', 'hypothesis', 'lookup', 'search']],
  ['agentes', ['agent', 'skill', 'prompt', 'karajan', 'promptfoo', 'dspy', 'router', 'pi-']],
  ['codigo', ['repo', 'code', 'ponytail', 'aider', 'graphify', 'testing', 'webapp']],
];

/** ISO con más de 3 decimales (Python) → Date; los microsegundos se pierden, igual que no cambian el día ni la semana. */
const fecha = (texto: string) => new Date(texto.replace(/(\.\d{3})\d+/, '$1'));
const r3 = (v: number, d = 3) => redondear(v, d);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const plegar = (s: string) => s.toLowerCase();

export const plano = (texto: string) => texto.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

export function nivelCorto(nivel: string | null | undefined): string | null {
  if (!nivel) return null;
  const m = /^(?:level_|n)(\d)/.exec(nivel.toLowerCase());
  return m ? `N${m[1]}` : null;
}

export function categoriaSkill(nombre: string, descripcion = ''): string {
  const texto = plano(`${nombre} ${descripcion.slice(0, 200)}`);
  for (const [categoria, claves] of CATEGORIAS_SKILL) if (claves.some((c) => texto.includes(c))) return categoria;
  return 'otras';
}

const palabras = (t: string) => plano(t).match(/[a-z0-9]+/g) ?? [];
function tejas(ps: string[], n = 8): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i + n <= ps.length; i++) s.add(ps.slice(i, i + n).join(' '));
  return s;
}
const referencias = (t: string) => new Set([...(plano(t).match(RUTA) ?? []), ...(t.match(COMPONENTE) ?? []).map((m) => m.toLowerCase())]);
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let comun = 0;
  for (const x of a) if (b.has(x)) comun++;
  return comun / new Set([...a, ...b]).size;
}

export function motivoRetrabajo(anterior: string, siguiente: string): string | null {
  const pa = palabras(anterior), ps = palabras(siguiente);
  const ta = tejas(pa);
  for (const t of tejas(ps)) if (ta.has(t)) return 'cita el prompt anterior';
  if (jaccard(referencias(anterior), referencias(siguiente)) >= 0.3) return 'vuelve sobre los mismos ficheros o componentes';
  const s = ` ${plano(siguiente)} `;
  const ca = new Set(pa.filter((p) => p.length >= 4)), cs = new Set(ps.filter((p) => p.length >= 4));
  if (CORRECCION.some((c) => s.includes(c)) && jaccard(ca, cs) >= 0.2) return 'pide corregir lo mismo';
  return null;
}

const revisado = (t: TareaAnalitica, campo: string) => t.revision?.[campo] ?? [];
function nivelDe(t: TareaAnalitica): string {
  const r = revisado(t, 'nivel_tarea').map(nivelCorto).filter((v): v is string => !!v);
  return r[0] ?? nivelCorto(t.nivel) ?? 'sin nivel';
}
function agenteDe(t: TareaAnalitica): string {
  const r = revisado(t, 'agente');
  if (r.length) return String(r[0]);
  for (const run of t.runs ?? []) if (run.provider_name) return String(run.provider_name);
  return 'sin delegar';
}
function entradaDe(t: TareaAnalitica): string {
  const r = revisado(t, 'agente_entrada');
  if (r.length) return String(r[0]);
  if (t.entry_agent) return String(t.entry_agent);
  return t.classified_by === 'model:/karajan' ? 'skill /karajan' : 'desconocido';
}
function dominioDe(t: TareaAnalitica): string {
  const r = revisado(t, 'dominio');
  const d = r.length ? r : t.dominios ?? [];
  return d.length ? String(d[0]) : 'general';
}
function skillsUsadas(t: TareaAnalitica): string[] {
  const r = revisado(t, 'skills_usadas');
  return [...new Set(r.length ? r : t.ejecutadas ?? [])].sort(cmp);
}

export function calcularAcierto(tareas: TareaAnalitica[]): Record<string, Acierto> {
  const orden = [...tareas].sort((a, b) => cmp(a.created_at, b.created_at) || cmp(a.task_id, b.task_id));
  const resultado: Record<string, Acierto> = {};
  orden.forEach((t, i) => {
    const inicio = fecha(t.created_at).getTime();
    let motivo: string | null = null;
    let repetidaPor: string | null = null;
    for (const sig of orden.slice(i + 1)) {
      if (fecha(sig.created_at).getTime() - inicio > VENTANA_MS) break;
      if (t.entry_agent && sig.entry_agent && t.entry_agent !== sig.entry_agent) continue;
      motivo = motivoRetrabajo(t.prompt ?? '', sig.prompt ?? '');
      if (motivo) { repetidaPor = sig.task_id; break; }
    }
    const senales: Record<string, number> = { retrabajo: motivo ? 0 : 1 };
    const runs = t.runs ?? [];
    if (runs.length || t.status === 'completed' || t.status === 'failed') {
      const sinError = t.status === 'completed' && !runs.some((r) => r.error || r.status === 'failed');
      senales['completada'] = sinError ? 1 : 0;
    }
    const decisiones = t.decisiones ?? [];
    const veredictos = decisiones.filter((d) => d.includes('verdict='));
    if (veredictos.length) senales['validacion'] = veredictos.some((d) => d.includes('verdict=needs_revision') || d.includes('verdict=failed') || d.includes('verdict=rejected')) ? 0 : 1;
    const puertas = decisiones.filter((d) => d.startsWith('human_review_gate='));
    if (puertas.length) senales['revision'] = puertas[puertas.length - 1] === 'human_review_gate=blocked' ? 0 : 1;
    let peso = 0, suma = 0;
    for (const k of Object.keys(senales)) peso += PESOS[k]!;
    for (const [k, v] of Object.entries(senales)) suma += PESOS[k]! * v;
    resultado[t.task_id] = { score: r3(suma / peso), senales, retrabajo: motivo, repetida_por: repetidaPor };
  });
  return resultado;
}

export function filtrar(tareas: TareaAnalitica[], o: { agentes: string[] | null; dias: number; ahora: Date }): TareaAnalitica[] {
  const corte = o.dias === 0 ? null : o.ahora.getTime() - o.dias * 86_400_000;
  const permitidos = o.agentes ? new Set(o.agentes) : null;
  return tareas.filter((t) => {
    if (corte !== null && fecha(t.created_at).getTime() < corte) return false;
    const a = agenteDe(t);
    return !(permitidos && a !== 'sin delegar' && !permitidos.has(a));
  });
}

const media = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const CAPAS: Record<string, number> = { entrada: 0, nivel: 1, agente: 2, estado: 3 };

export function flujo(tareas: TareaAnalitica[], acierto: Record<string, Acierto>) {
  const nodos = new Map<string, { id: string; capa: string; nombre: string; valor: number }>();
  const enlaces = new Map<string, { origen: string; destino: string; valor: number; tareas: string[]; _a: number[] }>();
  let desajustes = 0;
  for (const t of tareas) {
    const clasificado = nivelCorto(t.nivel) ?? 'sin nivel';
    const nivel = nivelDe(t);
    if (nivel !== clasificado) desajustes++;
    const capas: [string, string][] = [['entrada', entradaDe(t)], ['nivel', nivel], ['agente', agenteDe(t)], ['estado', String(t.status || '?')]];
    for (const [capa, nombre] of capas) {
      const id = `${capa}:${nombre}`;
      const n = nodos.get(id) ?? { id, capa, nombre, valor: 0 };
      n.valor++;
      nodos.set(id, n);
    }
    for (let i = 0; i < capas.length - 1; i++) {
      const o = `${capas[i]![0]}:${capas[i]![1]}`, d = `${capas[i + 1]![0]}:${capas[i + 1]![1]}`;
      const clave = `${o}\u0000${d}`;
      const e = enlaces.get(clave) ?? { origen: o, destino: d, valor: 0, tareas: [], _a: [] };
      e.valor++;
      if (e.tareas.length < 50) e.tareas.push(t.task_id);
      e._a.push(acierto[t.task_id]!.score);
      enlaces.set(clave, e);
    }
  }
  return {
    nodos: [...nodos.values()].sort((a, b) => CAPAS[a.capa]! - CAPAS[b.capa]! || b.valor - a.valor || cmp(a.nombre, b.nombre)),
    enlaces: [...enlaces.values()].map(({ _a, ...e }) => ({ ...e, acierto: r3(media(_a)) })).sort((a, b) => cmp(a.origen, b.origen) || b.valor - a.valor || cmp(a.destino, b.destino)),
    total: tareas.length,
    desajustes_nivel: desajustes,
    revisadas: tareas.filter((t) => t.revision && Object.keys(t.revision).length).length,
  };
}

function percentil(valores: number[], p: number): number | null {
  if (!valores.length) return null;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.max(0, Math.min(orden.length - 1, Math.ceil(p * orden.length) - 1))]!;
}

function semana(texto: string): string {
  const d = fecha(texto);
  const lunes = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return lunes.toISOString().slice(0, 10);
}

export function eficiencia(tareas: TareaAnalitica[], acierto: Record<string, Acierto>) {
  const porAgente = new Map<string, { latencias: number[]; costes: number[]; acierto: number[]; retrabajo: number; tareas: number }>();
  const porNivel = new Map<string, { agente: string; nivel: string; v: number[] }>();
  const porSemana = new Map<string, { semana: string; agente: string; v: number[] }>();
  for (const t of tareas) {
    const agente = agenteDe(t);
    if (agente === 'sin delegar') continue;
    const a = porAgente.get(agente) ?? { latencias: [], costes: [], acierto: [], retrabajo: 0, tareas: 0 };
    for (const run of t.runs ?? []) {
      if (run.latency_ms !== null && run.latency_ms !== undefined) a.latencias.push(Number(run.latency_ms));
      a.costes.push(Number(run.estimated_cost_usd || 0));
    }
    const score = acierto[t.task_id]!.score;
    a.acierto.push(score);
    a.tareas++;
    if (acierto[t.task_id]!.retrabajo) a.retrabajo++;
    porAgente.set(agente, a);
    const nv = nivelDe(t);
    const kn = `${agente}\u0000${nv}`;
    (porNivel.get(kn) ?? porNivel.set(kn, { agente, nivel: nv, v: [] }).get(kn)!).v.push(score);
    const s = semana(t.created_at);
    const ks = `${s}\u0000${agente}`;
    (porSemana.get(ks) ?? porSemana.set(ks, { semana: s, agente, v: [] }).get(ks)!).v.push(score);
  }
  const suma = (v: number[]) => v.reduce((s, x) => s + x, 0);
  return {
    agentes: [...porAgente.entries()].map(([agente, a]) => ({
      agente, tareas: a.tareas, runs: a.costes.length,
      coste_medio: a.costes.length ? r3(suma(a.costes) / a.costes.length, 5) : 0,
      coste_total: r3(suma(a.costes), 5),
      latencia_media: a.latencias.length ? r3(suma(a.latencias) / a.latencias.length, 1) : null,
      p50: percentil(a.latencias, 0.5), p90: percentil(a.latencias, 0.9),
      acierto: r3(suma(a.acierto) / a.acierto.length), retrabajo: r3(a.retrabajo / a.tareas),
    })).sort((x, y) => y.tareas - x.tareas || cmp(x.agente, y.agente)),
    por_nivel: [...porNivel.values()].map(({ agente, nivel, v }) => ({ agente, nivel, tareas: v.length, acierto: r3(suma(v) / v.length) }))
      .sort((x, y) => cmp(x.agente, y.agente) || cmp(x.nivel, y.nivel)),
    serie: [...porSemana.values()].map(({ semana: s, agente, v }) => ({ semana: s, agente, tareas: v.length, acierto: r3(suma(v) / v.length) }))
      .sort((x, y) => cmp(x.semana, y.semana) || cmp(x.agente, y.agente)),
  };
}

interface FilaMatriz { skill: string; categoria: string; instalada: boolean; usos: number; recomendada: number; celdas: Record<string, { usos: number; acierto: number }>; acierto: number | null; usada: boolean }

export function matrizSkills(tareas: TareaAnalitica[], acierto: Record<string, Acierto>, catalogo: SkillCatalogo[]) {
  const filas = new Map<string, FilaMatriz & { _a: number[]; _c: Record<string, number[]> }>();
  const nombres = new Map<string, string>();
  const fila = (nombre: string, descripcion = '', instalada = false) => {
    const k = plegar(nombre);
    if (!nombres.has(k)) nombres.set(k, nombre);
    const clave = nombres.get(k)!;
    if (!filas.has(clave)) filas.set(clave, { skill: clave, categoria: categoriaSkill(clave, descripcion), instalada, usos: 0, recomendada: 0, celdas: {}, acierto: null, usada: false, _a: [], _c: {} });
    return filas.get(clave)!;
  };
  for (const s of catalogo) fila(String(s.nombre), String(s.descripcion ?? ''), Boolean(s.instalada));
  const categorias = new Set<string>();
  for (const t of tareas) {
    const dominio = dominioDe(t);
    categorias.add(dominio);
    const score = acierto[t.task_id]!.score;
    for (const n of [...new Set(t.recomendadas ?? [])].sort(cmp)) fila(n).recomendada++;
    for (const n of skillsUsadas(t)) {
      const f = fila(n);
      f.usos++;
      f._a.push(score);
      (f._c[dominio] ??= []).push(score);
    }
  }
  const salida: FilaMatriz[] = [...filas.values()].map(({ _a, _c, ...f }) => ({
    ...f,
    celdas: Object.fromEntries(Object.entries(_c).map(([d, v]) => [d, { usos: v.length, acierto: r3(media(v)) }])),
    acierto: _a.length ? r3(media(_a)) : null,
    usada: f.usos > 0,
  }));
  return {
    categorias: [...categorias].sort(cmp),
    filas: salida.sort((a, b) => b.usos - a.usos || b.recomendada - a.recomendada || cmp(plegar(a.skill), plegar(b.skill))),
    usadas: salida.filter((f) => f.usada).length,
    total: salida.length,
  };
}

type Eficiencia = ReturnType<typeof eficiencia>;
type Matriz = ReturnType<typeof matrizSkills>;
export interface Sugerencia { id: string; severidad: 'alta' | 'media' | 'baja'; texto: string; accion: Record<string, string> | null; skills?: string[] }

export function sugerencias(efic: Eficiencia, matriz: Matriz, o: { ultima: string | null; ahora: Date; noDisponibles?: string[] }): Sugerencia[] {
  const salida: Sugerencia[] = [];
  for (const agente of [...(o.noDisponibles ?? [])].sort(cmp)) {
    salida.push({ id: `no-disponible:${agente}`, severidad: 'alta', texto: `${agente} está en el perfil pero no está disponible: sus tareas irán al respaldo.`, accion: null });
  }
  for (const f of efic.por_nivel) {
    if (f.tareas >= 3 && f.acierto < 0.6) {
      salida.push({ id: `nivel:${f.agente}:${f.nivel}`, severidad: 'alta', texto: `${f.agente} acierta ${formatear(f.acierto, 2)} en ${f.nivel} (${f.tareas} tareas): delega ese nivel en otro agente.`,
        accion: { tipo: 'quitar_nivel', agente: f.agente, nivel: f.nivel } });
    }
  }
  for (const a of efic.agentes) {
    if (a.tareas >= 4 && a.retrabajo >= 0.4) {
      salida.push({ id: `retrabajo:${a.agente}`, severidad: 'media', texto: `El ${redondear(a.retrabajo * 100, 0)} % de las tareas de ${a.agente} se repiten: revisa su nivel máximo o el prompt de entrada.`, accion: null });
    }
  }
  const nunca = matriz.filas.filter((f) => f.recomendada >= 3 && !f.usada).map((f) => f.skill);
  for (const n of nunca.slice(0, 5)) {
    salida.push({ id: `skill-sin-ejecutar:${n}`, severidad: 'media', texto: `${n} se recomienda a menudo pero nunca se ejecuta: asígnala a un agente del perfil.`, accion: { tipo: 'asignar_skill', skill: n } });
  }
  const sinUso = matriz.filas.filter((f) => f.instalada && !f.usada && !f.recomendada).map((f) => f.skill);
  if (sinUso.length) salida.push({ id: 'skills-sin-uso', severidad: 'baja', texto: `${sinUso.length} skills instaladas no se han usado en el periodo: candidatas a retirar.`, accion: null, skills: sinUso.slice(0, 30) });
  if (o.ultima) {
    const dias = Math.floor((o.ahora.getTime() - fecha(o.ultima).getTime()) / 86_400_000);
    if (dias >= 14) salida.push({ id: 'datos-antiguos', severidad: 'baja', texto: `El último dato tiene ${dias} días: delega tareas para que las métricas reflejen el perfil actual.`, accion: null });
  }
  const orden = { alta: 0, media: 1, baja: 2 };
  return salida.sort((a, b) => orden[a.severidad] - orden[b.severidad]);
}

export function catalogoAgrupado(matriz: Matriz, top = 10) {
  const resumen = (f: FilaMatriz) => ({ skill: f.skill, categoria: f.categoria, instalada: f.instalada, usos: f.usos, recomendada: f.recomendada, acierto: f.acierto });
  const filas = matriz.filas;
  return {
    instaladas: filas.filter((f) => f.instalada).map(resumen),
    sin_actividad: filas.filter((f) => f.instalada && !f.usada).map(resumen),
    top: filas.filter((f) => f.usada).slice(0, top).map(resumen),
    recomendadas_no_instaladas: filas.filter((f) => f.recomendada && !f.instalada).map(resumen),
    por_categoria: Object.fromEntries([...new Set(filas.map((f) => f.categoria))].sort(cmp).map((c) => [c, filas.filter((f) => f.categoria === c).length])),
  };
}

export function produccion(tareas: TareaAnalitica[], o: { catalogo: SkillCatalogo[]; agentesPerfil: string[] | null; dias: number; ahora: Date; noDisponibles?: string[] }) {
  const seleccion = filtrar(tareas, { agentes: o.agentesPerfil, dias: o.dias, ahora: o.ahora });
  // El re-trabajo mira el siguiente prompt aunque sea de otro agente o de fuera del periodo: se calcula sobre todas.
  const acierto = calcularAcierto(tareas);
  const efic = eficiencia(seleccion, acierto);
  const matriz = matrizSkills(seleccion, acierto, o.catalogo);
  const ultima = tareas.length ? tareas.map((t) => t.created_at).reduce((a, b) => (b > a ? b : a)) : null;
  const puntuadas = seleccion.filter((t) => agenteDe(t) !== 'sin delegar').map((t) => acierto[t.task_id]!.score);
  const revisadas = (t: TareaAnalitica) => Boolean(t.revision && Object.keys(t.revision).length);
  return {
    dias: o.dias,
    perfil: o.agentesPerfil ? 'activo' : 'todos',
    agentes_perfil: o.agentesPerfil ? [...o.agentesPerfil].sort(cmp) : null,
    ultima,
    kpis: {
      tareas: seleccion.length,
      delegadas: puntuadas.length,
      acierto: puntuadas.length ? r3(media(puntuadas)) : null,
      retrabajo: seleccion.length ? r3(seleccion.filter((t) => acierto[t.task_id]!.retrabajo).length / seleccion.length) : null,
      revisadas: seleccion.filter(revisadas).length,
    },
    flujo: flujo(seleccion, acierto),
    eficiencia: efic,
    matriz,
    sugerencias: sugerencias(efic, matriz, { ultima, ahora: o.ahora, noDisponibles: o.noDisponibles }),
    catalogo: catalogoAgrupado(matriz),
    acierto: Object.fromEntries(seleccion.map((t) => [t.task_id, acierto[t.task_id]!])),
  };
}
