import type { Comando } from './comandos';
import type { Bloque, Panel } from './panel';

/**
 * Comandos genéricos de cualquier componente (el «JDK»): `kj <componente> describe|config|salud|metricas`. No se escriben uno a uno:
 * se resuelven contra la vista `GET /laboratorio/arquitectura/:id`, que ya trae ficha, configuración viva, estado del
 * laboratorio, historial y operación de los 25 componentes. Un componente nuevo los tiene sin tocar la CLI.
 */
interface VistaComponente {
  id: string; familia: string; responsabilidad: string; modulos: string[]; estado: string; muestra_corta: boolean; pendiente: string | null;
  ficha: { especificado: boolean; resumen: string; como_funciona: { entradas: string[]; pasos: string[]; salidas: string[] }; reglas: string[] };
  configuracion: Record<string, unknown> | null;
  escenarios: { id: string; tipo: string; descripcion: string }[];
  ultimas: { escenario: string; inicio: string; muestra: number; suficiente: boolean; hallazgos: number; error: string | null; metricas: Record<string, number | null> }[];
  historial: Record<string, { valor: number }[]>;
  hallazgos: { severidad: string; titulo: string; escenario: string; borrador: { tarea: string; estado: string | null } | null }[];
  operacion: { tareas: number | null; runs: number | null; latencia_p50_ms: number | null; coste_total_usd: number | null; ultima_actividad: string | null; extra: Record<string, unknown> | null };
  avisos: string[];
}

export const ACCIONES_COMPONENTE = ['describe', 'config', 'salud', 'metricas'] as const;
const valor = (v: unknown) => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
const lista = (xs: string[]) => (xs.length ? xs.map((x) => `  • ${x}`) : ['  (ninguno)']);

export function panelDescribe(v: VistaComponente): Panel {
  const f = v.ficha;
  return { origen: v.id, titulo: `${v.id} · describe`, subtitulo: `${v.familia} · ${v.estado}`, datos: v, bloques: [
    { tipo: 'texto', lineas: [v.responsabilidad, '', f.resumen, '', `Módulos: ${v.modulos.join(', ') || '(vive fuera de Karajan)'}`] },
    { tipo: 'texto', titulo: 'Cómo funciona', lineas: ['Entradas', ...lista(f.como_funciona.entradas), 'Pasos', ...lista(f.como_funciona.pasos), 'Salidas', ...lista(f.como_funciona.salidas)] },
    ...(f.reglas.length ? [{ tipo: 'texto', titulo: 'Reglas', lineas: lista(f.reglas) } as Bloque] : []),
    { tipo: 'texto', titulo: 'Laboratorio', lineas: v.escenarios.length ? v.escenarios.map((e) => `${e.id} [${e.tipo}] ${e.descripcion}`) : [v.pendiente ?? '(sin laboratorio)'] },
  ] };
}

export function panelConfig(v: VistaComponente): Panel {
  const c = Object.entries(v.configuracion ?? {});
  return { origen: v.id, titulo: `${v.id} · config`, datos: v.configuracion, bloques: [{ tipo: 'tabla', columnas: ['parámetro', 'valor'], filas: c.map(([k, x]) => [k, valor(x)]) }, { tipo: 'texto', lineas: ['Solo lectura desde aquí; los cambios pasan por el guardián del modo producción (tarea aceptada).'] }] };
}

export function panelSalud(v: VistaComponente): Panel {
  return { origen: v.id, titulo: `${v.id} · salud`, subtitulo: v.estado + (v.muestra_corta ? ' (muestra corta)' : ''), datos: { estado: v.estado, ultimas: v.ultimas, hallazgos: v.hallazgos, avisos: v.avisos }, bloques: [
    { tipo: 'tabla', titulo: 'Último resultado por escenario', columnas: ['escenario', 'muestra', 'suficiente', 'hallazgos', 'error'], filas: v.ultimas.map((u) => [u.escenario, u.muestra, u.suficiente ? 'sí' : 'no', u.hallazgos, u.error]) },
    { tipo: 'texto', titulo: 'Hallazgos', lineas: v.hallazgos.length ? v.hallazgos.map((h) => `[${h.severidad}] ${h.titulo} (${h.escenario})${h.borrador ? ` → borrador ${h.borrador.tarea}${h.borrador.estado ? ` · ${h.borrador.estado}` : ''}` : ''}`) : ['Sin hallazgos.'] },
    ...(v.avisos.length ? [{ tipo: 'texto', titulo: 'Avisos', lineas: v.avisos } as Bloque] : []),
  ] };
}

export function panelMetricas(v: VistaComponente): Panel {
  const o = v.operacion;
  const filas: (string | number | null)[][] = [['tareas', o.tareas], ['ejecuciones', o.runs], ['latencia p50 (ms)', o.latencia_p50_ms], ['coste total ($)', o.coste_total_usd], ['última actividad', o.ultima_actividad], ...Object.entries(o.extra ?? {}).map(([k, x]) => [k, valor(x)])];
  const series = Object.entries(v.historial).slice(0, 6);
  return { origen: v.id, titulo: `${v.id} · métricas`, datos: { operacion: o, historial: v.historial }, bloques: [
    { tipo: 'tabla', titulo: 'Operación', columnas: ['métrica', 'valor'], filas },
    ...series.map(([k, pts]) => ({ tipo: 'serie', titulo: `Historial · ${k}`, puntos: pts.map((p) => p.valor) }) as Bloque),
  ] };
}

const PRESENTADORES = { describe: panelDescribe, config: panelConfig, salud: panelSalud, metricas: panelMetricas } as const;

/** Un comando por acción, con `*` en la posición del componente. */
export const comandosComponente: Comando[] = ACCIONES_COMPONENTE.map((accion) => ({
  ruta: ['*', accion], uso: `<componente> ${accion}`, resumen: { describe: 'ficha: qué hace, cómo y qué mide', config: 'configuración viva del componente', salud: 'estado de su laboratorio y hallazgos', metricas: 'su actividad real e historial' }[accion],
  ejecutar: async (ctx, _args, ruta) => PRESENTADORES[accion]((await ctx.pedir(`/laboratorio/arquitectura/${encodeURIComponent(ruta[0]!)}`)) as VistaComponente),
}));
