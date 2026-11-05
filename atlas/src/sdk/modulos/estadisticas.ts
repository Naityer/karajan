import type { Comando, Contexto } from '../comandos';
import type { Bloque, Panel } from '../panel';

/**
 * Módulo Estadísticas (fachada): compone lo que miden los componentes de observación (`produccion`, `analitica`, `almacen`) en
 * paneles. No tiene lógica propia de cálculo; solo pide los datos y los presenta. Equivale a las vistas «Resumen», «Agentes»,
 * «Tareas» y «Skills» del antiguo dashboard.
 */
interface Kpis { tareas: number; delegadas: number; acierto: number; retrabajo: number; revisadas: number }
interface AgenteEf { agente: string; tareas: number; runs: number; coste_medio: number | null; coste_total: number; latencia_media: number | null; p50: number | null; p90: number | null; acierto: number | null; retrabajo: number | null }
interface FilaSkill { skill: string; categoria: string; instalada: boolean; usos: number; recomendada: number; celdas?: Record<string, { usos: number; acierto: number | null }>; agentes?: Record<string, number> }
interface Produccion {
  dias: number; perfil: string; kpis: Kpis;
  flujo: { nodos: { id: string; capa: string; nombre: string; valor: number }[]; enlaces: { origen: string; destino: string; valor: number }[]; total: number };
  eficiencia: { agentes: AgenteEf[] };
  matriz: { categorias: string[]; filas: FilaSkill[]; usadas: number; total: number; serie?: { semana: string; skill: string; usos: number }[] };
  sugerencias: { severidad: string; texto: string }[];
  catalogo?: { instaladas?: number; sin_actividad?: unknown[]; recomendadas_no_instaladas?: unknown[] };
}
interface Tarea { task_id: string; status?: string; prompt?: string; created_at?: string; classification?: { complexity_level?: number | string; domain?: string[]; recommended_model?: string; requires_human_review?: boolean; criteria?: Record<string, number> }; delegation?: { total_latency_ms?: number; total_estimated_cost_usd?: number } }

const consulta = (ctx: Contexto) => `?dias=${encodeURIComponent(ctx.opcion('dias') ?? '30')}&perfil=${encodeURIComponent(ctx.opcion('perfil') ?? 'todos')}`;
const produccion = async (ctx: Contexto) => (await ctx.pedir(`/analytics/produccion${consulta(ctx)}`)) as Produccion;
const alcance = (p: Produccion) => `${p.dias ? `últimos ${p.dias} días` : 'todo el histórico'} · perfil ${p.perfil}`;
const orden = <T,>(xs: T[], clave: (x: T) => number) => [...xs].sort((a, b) => clave(b) - clave(a));

export function panelResumen(p: Produccion): Panel {
  const bloques: Bloque[] = [
    { tipo: 'tabla', titulo: 'Indicadores', columnas: ['tareas', 'delegadas', 'acierto', 're-trabajo', 'revisadas'], filas: [[p.kpis.tareas, p.kpis.delegadas, `${Math.round(p.kpis.acierto * 100)} %`, `${Math.round(p.kpis.retrabajo * 100)} %`, p.kpis.revisadas]] },
    { tipo: 'medidor', titulo: 'Acierto global', valor: p.kpis.acierto },
    { tipo: 'flujo', titulo: `Flujo de ${p.flujo.total} tareas (entrada → nivel → agente → estado)`, capas: [...new Set(p.flujo.nodos.map((n) => n.capa))].map((capa) => ({ nombre: capa, nodos: p.flujo.nodos.filter((n) => n.capa === capa).map((n) => ({ id: n.id, nombre: n.nombre, valor: n.valor })) })), enlaces: p.flujo.enlaces },
    { tipo: 'dispersion', titulo: 'Coste medio frente a latencia media por agente', ejeX: 'coste medio ($)', ejeY: 'latencia media (ms)', puntos: p.eficiencia.agentes.map((a) => ({ etiqueta: `${a.agente} (${a.tareas} tareas)`, x: a.coste_medio, y: a.latencia_media })) },
    { tipo: 'texto', titulo: 'Qué mejorar', lineas: p.sugerencias.length ? p.sugerencias.map((s) => `[${s.severidad}] ${s.texto}`) : ['Nada que mejorar.'] },
  ];
  return { origen: 'estadisticas', titulo: 'Estadísticas · resumen', subtitulo: alcance(p), bloques, datos: p };
}

export function panelAgentes(p: Produccion): Panel {
  const ags = orden(p.eficiencia.agentes, (a) => a.tareas);
  const bloques: Bloque[] = [
    { tipo: 'barras', titulo: 'Tareas por agente', filas: ags.map((a) => ({ etiqueta: a.agente, valor: a.tareas, nota: `${a.runs} ejecuciones` })) },
    { tipo: 'barras', titulo: 'Acierto por agente', unidad: 'pct', filas: ags.map((a) => ({ etiqueta: a.agente, valor: a.acierto, nota: a.retrabajo === null ? '' : `re-trabajo ${Math.round(a.retrabajo * 100)} %` })) },
    { tipo: 'rango', titulo: 'Latencia (p50 y p90)', unidad: ' ms', filas: ags.map((a) => ({ etiqueta: a.agente, p50: a.p50, p90: a.p90 })) },
    { tipo: 'tabla', titulo: 'Ranking', columnas: ['agente', 'tareas', 'ejecuciones', 'acierto', 'coste total $', 'coste medio $'], filas: ags.map((a) => [a.agente, a.tareas, a.runs, a.acierto === null ? null : `${Math.round(a.acierto * 100)} %`, a.coste_total, a.coste_medio]) },
  ];
  return { origen: 'estadisticas', titulo: 'Estadísticas · agentes', subtitulo: alcance(p), bloques, datos: p.eficiencia };
}

export function panelSkills(p: Produccion): Panel {
  const filas = orden(p.matriz.filas, (f) => f.usos);
  const porCategoria = new Map<string, number>();
  for (const f of filas) porCategoria.set(f.categoria, (porCategoria.get(f.categoria) ?? 0) + f.usos);
  const semanas = [...new Set((p.matriz.serie ?? []).map((s) => s.semana))].sort();
  const porSemana = semanas.map((w) => (p.matriz.serie ?? []).filter((s) => s.semana === w).reduce((t, s) => t + s.usos, 0));
  const agentes = [...new Set(filas.flatMap((f) => Object.keys(f.agentes ?? {})))];
  const top = filas.filter((f) => f.usos > 0).slice(0, 8);
  const bloques: Bloque[] = [
    { tipo: 'tabla', titulo: 'Indicadores', columnas: ['skills', 'usadas', 'sin uso'], filas: [[p.matriz.total, p.matriz.usadas, p.matriz.total - p.matriz.usadas]] },
    { tipo: 'serie', titulo: 'Actividad semanal (usos)', puntos: porSemana, etiquetas: semanas },
    { tipo: 'barras', titulo: 'Skills más usadas', filas: filas.slice(0, 10).map((f) => ({ etiqueta: f.skill, valor: f.usos, nota: `recomendada ${f.recomendada}` })) },
    { tipo: 'barras', titulo: 'Usos por categoría', filas: orden([...porCategoria].map(([c, v]) => ({ etiqueta: c, valor: v })), (f) => f.valor) },
    ...(top.length && agentes.length ? [{ tipo: 'heatmap', titulo: 'Agente × skill', filas: top.map((f) => f.skill), columnas: agentes, valores: top.map((f) => agentes.map((a) => f.agentes?.[a] ?? 0)) } as Bloque] : []),
    ...(top.length && p.matriz.categorias.length ? [{ tipo: 'heatmap', titulo: 'Skill × categoría', filas: top.map((f) => f.skill), columnas: p.matriz.categorias, valores: top.map((f) => p.matriz.categorias.map((c) => f.celdas?.[c]?.usos ?? 0)) } as Bloque] : []),
  ];
  return { origen: 'estadisticas', titulo: 'Estadísticas · skills', subtitulo: alcance(p), bloques, datos: p.matriz };
}

export function panelTareas(tareas: Tarea[]): Panel {
  const nivel = (t: Tarea) => t.classification?.complexity_level ?? null;
  return {
    origen: 'estadisticas', titulo: 'Estadísticas · tareas', subtitulo: `${tareas.length} más recientes`, datos: tareas,
    bloques: [{ tipo: 'tabla', columnas: ['id', 'estado', 'nivel', 'agente', 'revisión', 'coste $', 'creada'], filas: tareas.map((t) => [t.task_id.slice(0, 12), t.status ?? null, nivel(t) === null ? null : `N${nivel(t)}`, t.classification?.recommended_model ?? null, t.classification?.requires_human_review ? 'pendiente' : '', t.delegation?.total_estimated_cost_usd ?? null, (t.created_at ?? '').slice(0, 16)]) }],
  };
}

export function panelTarea(t: Tarea, decisiones: { phase: string; decision: string; reason?: string }[]): Panel {
  const criterios = Object.entries(t.classification?.criteria ?? {}).map(([k, v]) => ({ etiqueta: k, valor: v }));
  return {
    origen: 'estadisticas', titulo: `Estadísticas · tarea ${t.task_id}`, subtitulo: t.status, datos: { tarea: t, decisiones },
    bloques: [
      { tipo: 'texto', titulo: 'Entrada', lineas: [(t.prompt ?? '').slice(0, 400) || '(sin texto)'] },
      { tipo: 'barras', titulo: 'Criterios de clasificación (0-5)', filas: criterios },
      { tipo: 'texto', titulo: 'Decisiones del harness', lineas: decisiones.length ? decisiones.map((d) => `${d.phase}: ${d.decision}${d.reason ? ` — ${d.reason}` : ''}`) : ['(sin decisiones)'] },
    ],
  };
}

export const comandosEstadisticas: Comando[] = [
  { ruta: ['estadisticas', 'resumen'], uso: 'estadisticas resumen [--dias N] [--perfil activo|todos]', resumen: 'indicadores, flujo, coste/latencia y qué mejorar', ejecutar: async (ctx) => panelResumen(await produccion(ctx)) },
  { ruta: ['estadisticas', 'agentes'], uso: 'estadisticas agentes [--dias N] [--perfil activo|todos]', resumen: 'ranking, acierto y latencia por agente', ejecutar: async (ctx) => panelAgentes(await produccion(ctx)) },
  { ruta: ['estadisticas', 'skills'], uso: 'estadisticas skills [--dias N] [--perfil activo|todos]', resumen: 'actividad, uso por categoría y mapas de calor', ejecutar: async (ctx) => panelSkills(await produccion(ctx)) },
  { ruta: ['estadisticas', 'tareas'], uso: 'estadisticas tareas [--limite N]', resumen: 'las tareas más recientes', ejecutar: async (ctx) => {
    const d = (await ctx.pedir(`/tasks?limit=${encodeURIComponent(ctx.opcion('limite') ?? '20')}`)) as Tarea[] | { tasks?: Tarea[]; items?: Tarea[] };
    return panelTareas(Array.isArray(d) ? d : d.tasks ?? d.items ?? []);
  } },
  { ruta: ['estadisticas', 'tarea'], uso: 'estadisticas tarea <id>', resumen: 'detalle de una tarea: criterios y decisiones', ejecutar: async (ctx, args) => {
    const id = args.find((a) => !a.startsWith('--'));
    if (!id) throw new Error('uso: kj estadisticas tarea <id>');
    const [t, d] = await Promise.all([ctx.pedir(`/tasks/${encodeURIComponent(id)}`), ctx.pedir(`/tasks/${encodeURIComponent(id)}/decisions`).catch(() => [])]);
    return panelTarea(t as Tarea, d as { phase: string; decision: string; reason?: string }[]);
  } },
];
