import type { Comando, Contexto } from './comandos';
import type { NodoArbol } from './ascii';
import type { Bloque, Panel } from './panel';

/**
 * Comandos genéricos de cualquier componente (el «JDK»): `kj <componente> describe|config|salud|metricas`. No se escriben uno a uno:
 * se resuelven contra la vista `GET /laboratorio/arquitectura/:id`, que ya trae ficha, configuración viva, estado del
 * laboratorio, historial y operación de los 25 componentes. Un componente nuevo los tiene sin tocar la CLI.
 */
interface VistaComponente {
  id: string; familia: string; responsabilidad: string; modulos: string[]; requiere?: string[] | 'todos'; config?: { lectura: string; escritura?: string } | null; estado: string; muestra_corta: boolean; pendiente: string | null;
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
    { tipo: 'texto', lineas: [v.responsabilidad, '', f.resumen, '', `Módulos: ${v.modulos.join(', ') || '(vive fuera de Karajan)'}`, `Depende de: ${v.requiere === 'todos' ? 'todos (raíz de composición)' : v.requiere?.length ? v.requiere.join(', ') : 'nadie (independiente)'}`] },
    { tipo: 'texto', titulo: 'Cómo funciona', lineas: ['Entradas', ...lista(f.como_funciona.entradas), 'Pasos', ...lista(f.como_funciona.pasos), 'Salidas', ...lista(f.como_funciona.salidas)] },
    ...(f.reglas.length ? [{ tipo: 'texto', titulo: 'Reglas', lineas: lista(f.reglas) } as Bloque] : []),
    { tipo: 'texto', titulo: 'Laboratorio', lineas: v.escenarios.length ? v.escenarios.map((e) => `${e.id} [${e.tipo}] ${e.descripcion}`) : [v.pendiente ?? '(sin laboratorio)'] },
  ] };
}

export function panelConfig(v: VistaComponente): Panel {
  const c = Object.entries(v.configuracion ?? {});
  const aviso = v.config?.escritura ? `Se cambia con: kj ${v.id} config --set '<json con los campos a cambiar>' (en producción, el guardián exige una tarea aceptada).` : 'Solo lectura: este componente no declara una ruta de escritura de su configuración.';
  return { origen: v.id, titulo: `${v.id} · config`, datos: { configuracion: v.configuracion, rutas: v.config ?? null }, bloques: [{ tipo: 'tabla', columnas: ['parámetro', 'valor'], filas: c.map(([k, x]) => [k, valor(x)]) }, { tipo: 'texto', lineas: [aviso] }] };
}

/** `config --set '<json>'`: escribe en la ruta de escritura que el componente declara (PUT) y muestra lo que ha quedado. */
async function aplicarConfig(ctx: Contexto, v: VistaComponente, crudo: string): Promise<Panel> {
  if (!v.config?.escritura) throw new Error(`${v.id}: configuración de solo lectura (no declara ruta de escritura)`);
  let cuerpo: unknown;
  try { cuerpo = JSON.parse(crudo); } catch { throw new Error(`--set espera un JSON válido, p. ej. --set '{"campo": 1}'`); }
  if (!cuerpo || typeof cuerpo !== 'object' || Array.isArray(cuerpo)) throw new Error('--set espera un objeto JSON');
  const nuevo = await ctx.pedir(v.config.escritura, 'PUT', cuerpo);
  return { origen: v.id, titulo: `${v.id} · config actualizada`, datos: nuevo, bloques: [{ tipo: 'texto', lineas: ['Cambios aplicados:', ...Object.entries(cuerpo as Record<string, unknown>).map(([k, x]) => `  ${k} = ${valor(x)}`)] }] };
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

/** Dependencias entre componentes (de los imports reales, comprobados por el test de arquitectura), agrupadas por capa. */
export function panelDependencias(vistas: VistaComponente[]): Panel {
  const con = vistas.filter((v) => Array.isArray(v.requiere) && v.requiere.length), raices = vistas.filter((v) => v.requiere === 'todos');
  const libres = vistas.filter((v) => Array.isArray(v.requiere) && !v.requiere.length);
  const nodo = (v: VistaComponente): NodoArbol => ({ nombre: v.id, nota: `(${v.familia})`, hijos: ((v.requiere as string[]) ?? []).map((r) => ({ nombre: r })) });
  const usados = new Map<string, string[]>();
  for (const v of con) for (const r of v.requiere as string[]) usados.set(r, [...(usados.get(r) ?? []), v.id]);
  return { origen: 'componentes', titulo: 'Componentes · dependencias', subtitulo: `${vistas.length} componentes`, datos: vistas.map((v) => ({ id: v.id, familia: v.familia, requiere: v.requiere })), bloques: [
    { tipo: 'arbol', titulo: 'Quién depende de quién (en ejecución)', raiz: { nombre: 'Componentes con dependencias', hijos: con.map(nodo) } },
    { tipo: 'tabla', titulo: 'De quién dependen otros', columnas: ['componente', 'lo usan'], filas: [...usados].sort((a, b) => b[1].length - a[1].length).map(([c, us]) => [c, us.join(', ')]) },
    { tipo: 'texto', titulo: 'Independientes', lineas: [libres.map((v) => v.id).join(', ') || '(ninguno)'] },
    { tipo: 'texto', titulo: 'Raíces de composición (enchufan a todos)', lineas: [raices.map((v) => v.id).join(', ') || '(ninguna)'] },
  ] };
}

export const comandoDependencias: Comando = { ruta: ['componentes', 'dependencias'], resumen: 'mapa de dependencias entre componentes', ejecutar: async (ctx) => panelDependencias(((await ctx.pedir('/laboratorio/arquitectura')) as { componentes: VistaComponente[] }).componentes) };

/** Un comando por acción, con `*` en la posición del componente. */
export const comandosComponente: Comando[] = ACCIONES_COMPONENTE.map((accion) => ({
  ruta: ['*', accion], uso: accion === 'config' ? '<componente> config [--set <json>]' : `<componente> ${accion}`, resumen: { describe: 'ficha: qué hace, cómo y qué mide', config: 'configuración viva del componente', salud: 'estado de su laboratorio y hallazgos', metricas: 'su actividad real e historial' }[accion],
  ejecutar: async (ctx, _args, ruta) => {
    const v = (await ctx.pedir(`/laboratorio/arquitectura/${encodeURIComponent(ruta[0]!)}`)) as VistaComponente;
    const set = accion === 'config' ? ctx.opcion('set') : null;
    return set !== null ? aplicarConfig(ctx, v, set) : PRESENTADORES[accion](v);
  },
}));
