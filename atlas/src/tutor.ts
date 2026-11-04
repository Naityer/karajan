import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Fetch } from './atlas-dev';

/**
 * Qué modelo hace de tutor. Los agentes cambian cada semana, así que la elección no está escrita: se recalcula con la relación
 * razonamiento / precio de cada modelo de los dos proveedores con CLI (Claude Code y Codex).
 *   razonamiento  Artificial Analysis Intelligence Index (API v2, `ARTIFICIAL_ANALYSIS_API_KEY`).
 *   precio        OpenRouter `/api/v1/models` (público, sin clave); si falta, el que traiga Artificial Analysis.
 * Sin razonamiento medido un modelo no entra: no se adivina. Los precios son USD por millón de tokens.
 */
export type ProveedorTutor = 'claude-cli' | 'codex';
export interface ModeloTutor { proveedor: ProveedorTutor; modelo: string; razonamiento: number; precioEntrada: number; precioSalida: number; fuente: string }
export interface CatalogoTutores { actualizado: string; modelos: ModeloTutor[] }

/** Tokens de entrada por cada uno de salida con los que se mezcla el precio (el tutor lee mucho y contesta poco). */
export const MEZCLA_ENTRADA = 3;
export const UMBRALES_TUTOR = {
  /** Un tutor debe razonar al menos esta fracción de lo que razona el mejor de su proveedor: la relación sola premiaría al modelo barato y torpe. */
  razonamientoRelativoMin: 0.75,
  /** Pasados estos días el catálogo se da por obsoleto (se sigue usando, pero se avisa). */
  edadMaximaDias: 7,
};
const DIA = 86_400_000;

export const precioMezcla = (m: Pick<ModeloTutor, 'precioEntrada' | 'precioSalida'>) => (MEZCLA_ENTRADA * m.precioEntrada + m.precioSalida) / (MEZCLA_ENTRADA + 1);
/** Puntos de razonamiento por dólar mezclado por millón de tokens. */
export const valor = (m: ModeloTutor) => (precioMezcla(m) > 0 ? m.razonamiento / precioMezcla(m) : 0);

export interface Eleccion { proveedor: ProveedorTutor; modelo: string; razonamiento: number; precio_mezcla: number; valor: number; motivo: string }
export interface Seleccion {
  /** El tutor de esta ejecución; null si no hay ninguno utilizable. */
  tutor: Eleccion | null;
  /** El mejor de cada proveedor, por valor. */
  porProveedor: Eleccion[];
  obsoleto: boolean;
  /** Por qué no hay tutor, o por qué se descartó algún proveedor. */
  avisos: string[];
}

const redondeo = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function elegirTutores(c: CatalogoTutores | null, op: { disponibles?: ProveedorTutor[]; excluir?: ProveedorTutor[]; ahora?: number } = {}): Seleccion {
  const avisos: string[] = [];
  if (!c || !c.modelos.length) return { tutor: null, porProveedor: [], obsoleto: true, avisos: ['Sin catálogo de tutores: ejecuta `kj tutoria actualizar`.'] };
  const obsoleto = (op.ahora ?? Date.now()) - Date.parse(c.actualizado) > UMBRALES_TUTOR.edadMaximaDias * DIA;
  const porProveedor: Eleccion[] = [];
  for (const proveedor of ['claude-cli', 'codex'] as const) {
    const suyos = c.modelos.filter((m) => m.proveedor === proveedor && precioMezcla(m) > 0 && m.razonamiento > 0);
    if (!suyos.length) { avisos.push(`${proveedor}: sin modelos con razonamiento y precio medidos`); continue; }
    const techo = Math.max(...suyos.map((m) => m.razonamiento));
    const aptos = suyos.filter((m) => m.razonamiento >= techo * UMBRALES_TUTOR.razonamientoRelativoMin);
    const mejor = [...aptos].sort((a, b) => valor(b) - valor(a) || b.razonamiento - a.razonamiento || a.modelo.localeCompare(b.modelo))[0]!;
    porProveedor.push({
      proveedor, modelo: mejor.modelo, razonamiento: mejor.razonamiento, precio_mezcla: redondeo(precioMezcla(mejor)), valor: redondeo(valor(mejor)),
      motivo: `${mejor.razonamiento} puntos a ${redondeo(precioMezcla(mejor))} USD/Mtok mezclados; mejor de ${aptos.length} que razonan ≥ ${UMBRALES_TUTOR.razonamientoRelativoMin * 100} % de ${techo}`,
    });
  }
  const usables = porProveedor.filter((e) => (!op.disponibles || op.disponibles.includes(e.proveedor)) && !(op.excluir ?? []).includes(e.proveedor));
  for (const e of porProveedor.filter((x) => !usables.includes(x))) avisos.push(`${e.proveedor} no se usa ahora (no disponible o sobre su umbral semanal)`);
  const tutor = [...usables].sort((a, b) => b.valor - a.valor || a.proveedor.localeCompare(b.proveedor))[0] ?? null;
  if (!tutor) avisos.push('Ningún proveedor de tutor está disponible.');
  return { tutor, porProveedor, obsoleto, avisos };
}

// ── Catálogo en disco ──
export function leerCatalogo(ruta: string): CatalogoTutores | null {
  try {
    const c = JSON.parse(readFileSync(ruta, 'utf8')) as CatalogoTutores;
    return Array.isArray(c.modelos) && typeof c.actualizado === 'string' ? c : null;
  } catch { return null; }
}
export function guardarCatalogo(ruta: string, c: CatalogoTutores): void {
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, JSON.stringify(c, null, 2), 'utf8');
}
export const catalogoExiste = (ruta: string) => existsSync(ruta);

// ── Fuentes ──
interface Fila { id: string; creador: string | null; razonamiento: number | null; entrada: number | null; salida: number | null }
/** `anthropic/claude-sonnet-4.5:beta` → `claude-sonnet-4-5`: el mismo modelo con el mismo nombre en todas las fuentes. */
export const normalizar = (id: string) => id.toLowerCase().replace(/^[^/]*\//, '').replace(/:.*$/, '').replace(/-\d{8}$/, '').replace(/[._\s]+/g, '-').replace(/-+/g, '-');
const num = (x: unknown) => { const n = typeof x === 'string' ? Number(x) : typeof x === 'number' ? x : NaN; return Number.isFinite(n) ? n : null; };
const proveedorDe = (creador: string | null, id: string): ProveedorTutor | null => {
  const c = (creador ?? '').toLowerCase();
  if ((c.includes('anthropic') || c === '') && /^claude-/.test(id)) return 'claude-cli';
  if ((c.includes('openai') || c === '') && /^gpt-/.test(id)) return 'codex';
  return null;
};

/** OpenRouter da el precio por TOKEN en texto: se pasa a USD por millón. */
export async function leerOpenRouter(f: Fetch): Promise<Fila[]> {
  const r = await f('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error(`OpenRouter respondió ${r.status}`);
  const datos = ((await r.json()) as { data?: { id?: string; pricing?: { prompt?: unknown; completion?: unknown } }[] }).data ?? [];
  return datos.filter((m) => m.id).map((m) => {
    const e = num(m.pricing?.prompt), s = num(m.pricing?.completion);
    return { id: normalizar(m.id!), creador: m.id!.split('/')[0] ?? null, razonamiento: null, entrada: e === null ? null : e * 1e6, salida: s === null ? null : s * 1e6 };
  });
}

/** Artificial Analysis v2: `evaluations.artificial_analysis_intelligence_index` y, en Pro, `pricing.price_1m_*_tokens`. */
export async function leerArtificialAnalysis(f: Fetch, clave: string): Promise<Fila[]> {
  const r = await f('https://artificialanalysis.ai/api/v2/data/llms/models', { headers: { 'x-api-key': clave } });
  if (!r.ok) throw new Error(`Artificial Analysis respondió ${r.status}`);
  type M = { slug?: string; name?: string; model_creator?: { slug?: string; name?: string }; evaluations?: Record<string, unknown>; pricing?: Record<string, unknown> };
  const datos = ((await r.json()) as { data?: M[] }).data ?? [];
  return datos.filter((m) => m.slug || m.name).map((m) => ({
    id: normalizar(m.slug ?? m.name!), creador: m.model_creator?.slug ?? m.model_creator?.name ?? null, razonamiento: num(m.evaluations?.['artificial_analysis_intelligence_index']),
    entrada: num(m.pricing?.['price_1m_input_tokens']), salida: num(m.pricing?.['price_1m_output_tokens']),
  }));
}

/** Une las filas por nombre normalizado: razonamiento de Artificial Analysis, precio de OpenRouter (o, si falta, el de Artificial Analysis). */
export function combinar(razonamiento: Fila[], precios: Fila[]): ModeloTutor[] {
  const porId = new Map(precios.map((p) => [p.id, p]));
  const fuente = precios.length ? 'artificialanalysis+openrouter' : 'artificialanalysis';
  const salida: ModeloTutor[] = [];
  for (const r of razonamiento) {
    const proveedor = proveedorDe(r.creador, r.id);
    const p = porId.get(r.id);
    const entrada = p?.entrada ?? r.entrada, sal = p?.salida ?? r.salida;
    if (!proveedor || !r.razonamiento || entrada === null || sal === null || entrada < 0 || sal < 0 || entrada + sal === 0) continue;
    if (!salida.some((m) => m.modelo === r.id)) salida.push({ proveedor, modelo: r.id, razonamiento: r.razonamiento, precioEntrada: redondeo(entrada, 4), precioSalida: redondeo(sal, 4), fuente });
  }
  return salida;
}

export interface ResultadoActualizacion {
  catalogo: CatalogoTutores | null;
  /** El tutor antes y después (null si no había o no se puede elegir): lo que cambió esta semana. */
  antes: Eleccion | null; despues: Eleccion | null; cambio: boolean;
  error: string | null;
}

/**
 * Recalcula el catálogo con las fuentes en vivo. Si falla (sin clave, sin red, sin modelos reconocibles) el fichero NO se toca:
 * se sigue usando el anterior y el error se devuelve.
 */
export async function actualizarCatalogo(ruta: string, op: { fetch?: Fetch; clave?: string | null; ahora?: () => Date } = {}): Promise<ResultadoActualizacion> {
  const f = op.fetch ?? (fetch as unknown as Fetch);
  const anterior = leerCatalogo(ruta);
  const antes = elegirTutores(anterior).tutor;
  const clave = op.clave === undefined ? process.env['ARTIFICIAL_ANALYSIS_API_KEY'] ?? null : op.clave;
  try {
    if (!clave) throw new Error('Falta ARTIFICIAL_ANALYSIS_API_KEY: sin razonamiento medido no se elige tutor (el precio solo no basta).');
    const [razon, precios] = await Promise.all([leerArtificialAnalysis(f, clave), leerOpenRouter(f).catch(() => [] as Fila[])]);
    const modelos = combinar(razon, precios);
    if (!modelos.length) throw new Error('Las fuentes no dieron ningún modelo de Claude o GPT con razonamiento y precio.');
    const catalogo: CatalogoTutores = { actualizado: (op.ahora ?? (() => new Date()))().toISOString(), modelos };
    guardarCatalogo(ruta, catalogo);
    const despues = elegirTutores(catalogo).tutor;
    return { catalogo, antes, despues, cambio: `${antes?.proveedor}/${antes?.modelo}` !== `${despues?.proveedor}/${despues?.modelo}`, error: null };
  } catch (e) {
    return { catalogo: anterior, antes, despues: antes, cambio: false, error: String((e as Error).message ?? e).slice(0, 400) };
  }
}
