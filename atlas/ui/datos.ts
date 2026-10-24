import { useSyncExternalStore } from 'react';

import type { Arquitectura, Componente, Estado, PuntoHistorial } from './tipos';

/**
 * Estado compartido de la ventana. El panel lateral y la página central son dos componentes de React separados que Atlas dev monta
 * por su cuenta; los dos leen y escriben aquí (selección, filtros, datos), igual que hace Finance Manager con sus preferencias.
 * `__KJ_DEMO__` lo fija el empaquetador: en el paquete es `false` y el esquema de ejemplo ni siquiera entra en el bundle.
 */
declare const __KJ_DEMO__: boolean;

export type Pestana = 'resumen' | 'laboratorio' | 'funciona' | 'rendimiento';
export type Filtro = Estado | 'todos';
export interface Aviso { tipo: 'ok' | 'error'; texto: string }
export interface Vista {
  api: string;
  fase: 'cargando' | 'ok' | 'error';
  datos: Arquitectura | null;
  error: string | null;
  demo: boolean;
  seleccion: string | null;
  pestana: Pestana;
  filtro: Filtro;
  busqueda: string;
  flujo: boolean;
  tarea: string;
  ejecutando: string | null;
  aviso: Aviso | null;
}

let vista: Vista = { api: '', fase: 'cargando', datos: null, error: null, demo: false, seleccion: null, pestana: 'resumen', filtro: 'todos', busqueda: '', flujo: false, tarea: '', ejecutando: null, aviso: null };
const oyentes = new Set<() => void>();
export function poner(parcial: Partial<Vista>): void {
  vista = { ...vista, ...parcial };
  oyentes.forEach((f) => f());
}
const suscribir = (f: () => void) => { oyentes.add(f); return () => { oyentes.delete(f); }; };
export const useVista = (): Vista => useSyncExternalStore(suscribir, () => vista, () => vista);
export const leerVista = (): Vista => vista;

const esDemo = (): boolean => __KJ_DEMO__ && typeof location !== 'undefined' && new URLSearchParams(location.search).get('demo') === '1';

async function pedir<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`.trim();
    try { const j = await r.json() as { error?: string; mensaje?: string }; msg = j.error ?? j.mensaje ?? msg; } catch { /* sin cuerpo JSON */ }
    throw new Error(msg);
  }
  return r.json() as Promise<T>;
}

let enVuelo: Promise<void> | null = null;
/** Carga (o recarga) el esquema. Lectura pura: `GET /laboratorio/arquitectura` no escribe nada. */
export function cargar(api: string): Promise<void> {
  if (enVuelo && vista.api === api) return enVuelo;
  poner({ api, demo: esDemo(), fase: vista.datos ? vista.fase : 'cargando' });
  enVuelo = (async () => {
    try {
      let datos: Arquitectura;
      const externo = vista.demo ? new URLSearchParams(location.search).get('fixture') : null;
      if (externo) datos = await pedir<Arquitectura>(externo);
      else if (vista.demo) {
        datos = (await import('./fixtures/arquitectura.json')).default as unknown as Arquitectura;
        // Solo en el arnés: ?modo=produccion enseña el campo de la tarea aceptada.
        if (new URLSearchParams(location.search).get('modo') === 'produccion') datos = { ...datos, modo: 'produccion' };
      }
      else datos = await pedir<Arquitectura>(`${api}/laboratorio/arquitectura`);
      if (!Array.isArray(datos?.componentes) || !Array.isArray(datos?.familias)) throw new Error('La respuesta no tiene el formato de la arquitectura');
      poner({ datos: normalizar(datos), fase: 'ok', error: null });
    } catch (e) {
      poner({ fase: 'error', error: e instanceof Error ? e.message : String(e) });
    } finally { enVuelo = null; }
  })();
  return enVuelo;
}

/** El servidor puede mandar null donde la UI espera vacío (umbrales, detalle, métricas…): se rellena una vez, al cargar. */
function normalizar(d: Arquitectura): Arquitectura {
  return {
    ...d, enlaces: d.enlaces ?? [],
    componentes: d.componentes.map((c) => ({
      ...c, modulos: c.modulos ?? [], configuracion: c.configuracion ?? {}, historial: c.historial ?? {}, detalle: c.detalle ?? {}, hallazgos: c.hallazgos ?? [], avisos: c.avisos ?? [],
      ficha: { ...c.ficha, como_funciona: { entradas: c.ficha?.como_funciona?.entradas ?? [], pasos: c.ficha?.como_funciona?.pasos ?? [], salidas: c.ficha?.como_funciona?.salidas ?? [] }, resumen: c.ficha?.resumen ?? '' },
      escenarios: (c.escenarios ?? []).map((e) => ({ ...e, umbrales: e.umbrales ?? {} })),
      ultimas: (c.ultimas ?? []).map((u) => ({ ...u, metricas: u.metricas ?? {} })),
    })),
  };
}

/** Ejecuta un laboratorio (o todos). Única acción que muta: solo se llama desde un clic explícito. `proponer` va siempre en false. */
export async function ejecutar(componente: string | 'todos'): Promise<void> {
  const v = vista;
  if (v.ejecutando) return;
  const todos = componente === 'todos';
  poner({ ejecutando: componente, aviso: null });
  try {
    if (v.demo) await new Promise((r) => setTimeout(r, 900));
    else {
      await pedir(`${v.api}/laboratorio/ejecutar`, {
        method: 'POST',
        body: JSON.stringify({ ...(todos ? { todos: true } : { componente }), proponer: false, ...(v.tarea.trim() ? { tarea: v.tarea.trim() } : {}) }),
      });
    }
    poner({ aviso: { tipo: 'ok', texto: todos ? 'Laboratorios ejecutados.' : `Laboratorio de «${componente}» ejecutado.` } });
    await cargar(v.api);
  } catch (e) {
    poner({ aviso: { tipo: 'error', texto: e instanceof Error ? e.message : String(e) } });
  } finally { poner({ ejecutando: null }); }
}

// ── Lectura de los datos ────────────────────────────────────────────────────────────────────────────

export const componentePorId = (d: Arquitectura | null, id: string | null): Componente | null => (d && id ? d.componentes.find((c) => c.id === id) ?? null : null);

/** La métrica que resume a cada componente en su caja. */
const CLAVE: Record<string, string> = { delegador: 'concordancia', selector: 'f1', clasificador: 'nivel_exacto', biblioteca: 'con_ficha' };
export function metricaClave(c: Componente): string | null {
  const k = CLAVE[c.id];
  if (k && (c.historial[k]?.length || c.ultimas.some((u) => k in u.metricas))) return k;
  const h = Object.keys(c.historial)[0];
  if (h) return h;
  const m = c.ultimas.flatMap((u) => Object.keys(u.metricas))[0];
  return m ?? null;
}
export function valorActual(c: Componente, metrica: string): number | null {
  const h = c.historial[metrica];
  if (h?.length) return h[h.length - 1]!.valor;
  for (const u of c.ultimas) if (metrica in u.metricas) return u.metricas[metrica] ?? null;
  return null;
}
export const serieDe = (c: Componente, metrica: string): number[] => (c.historial[metrica] ?? []).map((p: PuntoHistorial) => p.valor).filter((v): v is number => typeof v === 'number');

export const esPorcentaje = (m: string): boolean => PORCENTAJE.has(m);
const PORCENTAJE = new Set(['concordancia', 'concordancia_ic_inf', 'concordancia_ic_sup', 'trazabilidad', 'estabilidad', 'auto_igual_que_entonces', 'hit1', 'precision3', 'recall3', 'f1', 'falsos_positivos', 'f1_actual', 'f1_calibrado', 'hit1_actual', 'hit1_calibrado', 'nivel_exacto', 'nivel_mas_menos_1', 'dominio', 'con_ficha', 'estrellas_propias', 'estrellas_heredadas', 'sin_grupo']);
const ETIQUETAS: Record<string, string> = {
  concordancia: 'Concordancia', concordancia_ic_inf: 'Concordancia (IC95 inf.)', concordancia_ic_sup: 'Concordancia (IC95 sup.)', trazabilidad: 'Trazabilidad', estabilidad: 'Estabilidad',
  auto_igual_que_entonces: 'Auto = entonces', hit1: 'Hit@1', precision3: 'Precisión@3', recall3: 'Recall@3', f1: 'F1', falsos_positivos: 'Falsos positivos', f1_actual: 'F1 actual', f1_calibrado: 'F1 calibrado',
  hit1_actual: 'Hit@1 actual', hit1_calibrado: 'Hit@1 calibrado', mejora_f1: 'Mejora de F1', nivel_exacto: 'Nivel exacto', nivel_mas_menos_1: 'Nivel ±1', dominio: 'Dominio', con_ficha: 'Con ficha',
  estrellas_propias: 'Estrellas propias', estrellas_heredadas: 'Estrellas heredadas', sin_grupo: 'Sin grupo', reglas_tapadas: 'Reglas tapadas', reglas_sin_uso: 'Reglas sin uso', reglas_activas: 'Reglas activas',
  niveles_sin_agente: 'Niveles sin agente', no_seleccionables: 'No seleccionables', sin_descripcion: 'Sin descripción', segmentos_inadecuados: 'Segmentos inadecuados', segmentos_evaluables: 'Segmentos evaluables',
};
export const etiquetaMetrica = (m: string): string => ETIQUETAS[m] ?? (m.charAt(0).toUpperCase() + m.slice(1).replace(/_/g, ' '));
export function formatear(metrica: string, v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  if (PORCENTAJE.has(metrica)) return `${(v * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %`;
  if (metrica === 'mejora_f1') return `${v >= 0 ? '+' : ''}${(v * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} pp`;
  return Number.isInteger(v) ? v.toLocaleString('es-ES') : v.toLocaleString('es-ES', { maximumFractionDigits: 3 });
}

// ── Umbrales: «>= 0.8», «≤ 0.3», «= 1», «IC95 superior ≥ 0.6», «≤ 20 %» ────────────────────────────────

export interface Umbral { op: '>=' | '<=' | '>' | '<' | '='; valor: number; texto: string }
export function parsearUmbral(texto: string | undefined): Umbral | null {
  if (!texto) return null;
  const m = /(>=|<=|≥|≤|=|>|<)\s*(\d+(?:[.,]\d+)?)\s*(%)?/.exec(texto);
  if (!m) return null;
  const op = m[1] === '≥' ? '>=' : m[1] === '≤' ? '<=' : (m[1] as Umbral['op']);
  let valor = Number(m[2]!.replace(',', '.'));
  if (m[3]) valor /= 100;
  return { op, valor, texto };
}
export function cumple(v: number | null, u: Umbral): boolean | null {
  if (v === null) return null;
  const e = 1e-9;
  switch (u.op) {
    case '>=': return v >= u.valor - e;
    case '<=': return v <= u.valor + e;
    case '>': return v > u.valor;
    case '<': return v < u.valor;
    default: return Math.abs(v - u.valor) < 1e-6;
  }
}
/** El umbral de una métrica: está en los umbrales del escenario que la produce, bajo su mismo nombre. */
export function umbralDe(c: Componente, metrica: string): Umbral | null {
  const esc = c.historial[metrica]?.at(-1)?.escenario ?? c.ultimas.find((u) => metrica in u.metricas)?.escenario;
  const e = c.escenarios.find((x) => x.id === esc);
  return parsearUmbral(e?.umbrales[metrica]) ?? parsearUmbral(c.escenarios.find((x) => x.umbrales[metrica])?.umbrales[metrica]);
}

// ── Tiempo ──────────────────────────────────────────────────────────────────────────────────────────

export function fechaCorta(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
}
export function fechaHora(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
export function duracion(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} s`;
  return `${(ms / 60000).toLocaleString('es-ES', { maximumFractionDigits: 1 })} min`;
}

/** Descripción accesible de una caja: «delegador, con hallazgos abiertos, concordancia 74 %». */
export function contarEstados(d: Arquitectura): Record<Estado, number> {
  const n: Record<Estado, number> = { ok: 0, hallazgos: 0, sin_ejecutar: 0, pendiente: 0, error: 0 };
  for (const c of d.componentes) n[c.estado]++;
  return n;
}
export function coincide(c: Componente, f: Filtro, q: string): boolean {
  if (f !== 'todos' && c.estado !== f) return false;
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return c.id.includes(t) || c.responsabilidad.toLowerCase().includes(t) || c.modulos.some((m) => m.includes(t));
}
