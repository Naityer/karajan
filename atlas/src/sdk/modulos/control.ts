import type { Comando, Contexto } from '../comandos';
import type { Bloque, Panel } from '../panel';
import type { NodoArbol } from '../ascii';

/**
 * Módulo Control (fachada): lo que antes veía el operador en «Control humano» y «Decisión» — quién trabaja, con qué carga, qué
 * decide el delegador y qué espera revisión — compuesto sobre los componentes `delegador`, `clasificador`, `dosificador`,
 * `proveedores`, `modo` y `pasarela`. El canvas isométrico no tiene equivalente 1:1: aquí es un mapa de equipos con su carga.
 */
interface Entidad { id: string; name?: string | null; role?: string; provider?: string | null; levels?: string[]; skills?: string[]; max_concurrent?: number; parentId?: string | null; parent_id?: string | null; target_ids?: string[]; memberships?: { group_id: string; prio?: number }[] }
interface Grupo { id: string; name?: string }
interface Regla { id: string; name?: string; entity_id: string; domains?: string[]; intents?: string[]; level_min?: number | null; level_max?: number | null; enabled?: boolean }
interface Perfil { id: string; name: string; entities: Entidad[]; rules?: Regla[] }
interface Layout { entities: Entidad[]; groups: Grupo[]; rules: Regla[]; profiles: Perfil[]; active_profile_id: string; default_profile_id: string }
interface Rendimiento { provider_name: string; task_count: number; error_count: number; avg_latency_ms: number | null; total_cost: number | null }
interface Proveedor { nombre: string; etiqueta: string; gratis: boolean; disponible: boolean; motivo: string | null }
interface Tarea { task_id: string; status?: string; prompt?: string; created_at?: string; classification?: { complexity_level?: number | string; recommended_model?: string; requires_human_review?: boolean; domain?: string[]; reason?: string }; delegation?: { executions?: { status?: string }[] } }
interface InfoAgente { usadoPct: number | null; usadoSesionPct: number | null; presupuestoPct: number | null; modo: string; disponible: boolean; retrasoMin: number }
interface EstadoDosificador { simulacion?: boolean; modo: string; burn: number | null; agotamiento: string | null; circuitos: Record<string, boolean>; agentes: Record<string, InfoAgente>; en_vuelo?: unknown[] }

const perfilDefecto = (l: Layout): { id: string; name: string; entidades: Entidad[]; reglas: Regla[] } => {
  const p = l.profiles?.find((x) => x.id === (l.default_profile_id || l.active_profile_id)) ?? l.profiles?.[0];
  return p ? { id: p.id, name: p.name, entidades: p.entities ?? [], reglas: p.rules ?? [] } : { id: '(lienzo)', name: 'sin perfiles', entidades: l.entities ?? [], reglas: l.rules ?? [] };
};
const nombreDe = (e: Entidad) => e.name || e.id;
const cola = <T,>(ctx: Contexto, ruta: string, defecto: T): Promise<T> => ctx.pedir(ruta).then((x) => x as T, () => defecto);

export function panelMapa(layout: Layout, rendimiento: Rendimiento[], dosificador: EstadoDosificador | null, tareas: Tarea[]): Panel {
  const perfil = perfilDefecto(layout);
  const carga = new Map(rendimiento.map((r) => [r.provider_name, r]));
  const grupos = new Map((layout.groups ?? []).map((g) => [g.id, g.name || g.id]));
  const zonas = new Map<string, Entidad[]>();
  for (const e of perfil.entidades) {
    const zona = (e.memberships ?? []).map((m) => grupos.get(m.group_id) ?? m.group_id)[0] ?? 'Sin grupo';
    zonas.set(zona, [...(zonas.get(zona) ?? []), e]);
  }
  const bloques: Bloque[] = [...zonas].map(([zona, es]) => ({
    tipo: 'tabla', titulo: `Zona · ${zona}`, columnas: ['agente', 'rol', 'proveedor', 'niveles', 'tareas', 'errores', 'cuota usada'],
    filas: es.map((e) => {
      const r = carga.get(e.provider ?? '') ?? carga.get(e.id), d = dosificador?.agentes?.[e.provider ?? ''] ?? dosificador?.agentes?.[e.id];
      return [nombreDe(e), e.role ?? null, e.provider ?? null, (e.levels ?? []).map((l) => l.replace(/^level_(\d).*/, 'N$1')).join(' '), r?.task_count ?? 0, r?.error_count ?? 0, d?.usadoPct == null ? null : `${Math.round(d.usadoPct)} %`];
    }),
  }));
  bloques.push({ tipo: 'barras', titulo: 'Carga: tareas por agente', filas: rendimiento.map((r) => ({ etiqueta: r.provider_name, valor: r.task_count, nota: r.error_count ? `${r.error_count} con error` : '' })) });
  bloques.push({ tipo: 'texto', titulo: 'Actividad reciente', lineas: tareas.length ? tareas.slice(0, 8).map((t) => `${(t.created_at ?? '').slice(5, 16)}  ${t.task_id.slice(0, 10)}  ${(t.status ?? '').padEnd(10)} N${t.classification?.complexity_level ?? '?'} → ${t.classification?.recommended_model ?? '—'}${t.classification?.requires_human_review ? '  ⚑ revisión' : ''}`) : ['(sin tareas)'] });
  return { origen: 'control', titulo: 'Control · mapa', subtitulo: `perfil ${perfil.name} · ${perfil.entidades.length} agentes`, bloques, datos: { perfil: perfil.id, entidades: perfil.entidades, rendimiento, dosificador, tareas } };
}

export function panelJerarquia(layout: Layout, perfilId: string | null): Panel {
  const base = perfilId ? layout.profiles?.find((p) => p.id === perfilId) : null;
  const p = base ? { id: base.id, name: base.name, entidades: base.entities ?? [], reglas: base.rules ?? [] } : perfilDefecto(layout);
  const padre = (e: Entidad) => e.parentId ?? e.parent_id ?? null;
  const ids = new Set(p.entidades.map((e) => e.id));
  const nodo = (e: Entidad, visto: Set<string>): NodoArbol => ({
    nombre: nombreDe(e),
    nota: [e.role, e.provider, (e.levels ?? []).map((l) => l.replace(/^level_(\d).*/, 'N$1')).join('/'), e.max_concurrent ? `×${e.max_concurrent}` : '', e.target_ids?.length ? `vigila: ${e.target_ids.join(', ')}` : ''].filter(Boolean).join(' · '),
    hijos: p.entidades.filter((h) => padre(h) === e.id && !visto.has(h.id)).map((h) => nodo(h, new Set([...visto, e.id]))),
  });
  const raices = p.entidades.filter((e) => !padre(e) || !ids.has(padre(e)!));
  const raiz: NodoArbol = { nombre: `Perfil ${p.name}`, nota: `(${p.id})`, hijos: raices.map((e) => nodo(e, new Set([e.id]))) };
  const reglas = p.reglas.map((r) => [r.id, r.enabled === false ? 'off' : 'on', r.entity_id, (r.domains ?? []).join(',') || '*', (r.intents ?? []).join(',') || '*', `${r.level_min ?? 1}-${r.level_max ?? 5}`]);
  return { origen: 'control', titulo: 'Control · jerarquía', subtitulo: `perfil ${p.name}`, datos: p, bloques: [
    { tipo: 'arbol', titulo: 'Quién delega en quién', raiz },
    { tipo: 'tabla', titulo: 'Reglas de enrutado', columnas: ['regla', 'estado', 'agente', 'dominios', 'intenciones', 'niveles'], filas: reglas },
  ] };
}

export function panelPerfiles(layout: Layout): Panel {
  return { origen: 'control', titulo: 'Control · perfiles', datos: layout.profiles, bloques: [{ tipo: 'tabla', columnas: ['id', 'nombre', 'agentes', 'reglas', 'marca'], filas: (layout.profiles ?? []).map((p) => [p.id, p.name, p.entities?.length ?? 0, p.rules?.length ?? 0, [p.id === layout.default_profile_id ? 'ejecuta' : '', p.id === layout.active_profile_id ? 'editando' : ''].filter(Boolean).join(' + ')]) }] };
}

export function panelProveedores(ps: Proveedor[]): Panel {
  return { origen: 'control', titulo: 'Control · proveedores', subtitulo: `${ps.filter((p) => p.disponible).length} de ${ps.length} disponibles`, datos: ps, bloques: [{ tipo: 'tabla', columnas: ['proveedor', 'etiqueta', 'gratis', 'estado', 'motivo'], filas: ps.map((p) => [p.nombre, p.etiqueta, p.gratis ? 'sí' : 'no', p.disponible ? 'listo' : 'no disponible', p.motivo]) }] };
}

export function panelRevisiones(tareas: Tarea[]): Panel {
  const pend = tareas.filter((t) => t.classification?.requires_human_review);
  return { origen: 'control', titulo: 'Control · revisiones', subtitulo: `${pend.length} esperan revisión humana`, datos: pend, bloques: [
    { tipo: 'tabla', columnas: ['id', 'nivel', 'estado', 'agente', 'dominio', 'creada'], filas: pend.map((t) => [t.task_id.slice(0, 12), `N${t.classification?.complexity_level ?? '?'}`, t.status ?? null, t.classification?.recommended_model ?? null, (t.classification?.domain ?? []).join(','), (t.created_at ?? '').slice(0, 16)]) },
    { tipo: 'texto', lineas: ['La aprobación se hace desde la tarea de Atlas dev (en producción, solo con una tarea aceptada).'] },
  ] };
}

export function panelCuota(d: EstadoDosificador): Panel {
  const ags = Object.entries(d.agentes ?? {});
  return { origen: 'control', titulo: 'Control · cuota', subtitulo: `modo ${d.modo}${d.simulacion ? ' (simulación)' : ''}`, datos: d, bloques: [
    ...ags.map(([a, x]) => ({ tipo: 'medidor', titulo: `${a} · semana${d.circuitos?.[a] ? ' · CIRCUITO ABIERTO' : ''} · ${x.modo}${x.disponible ? '' : ' · no disponible'}`, valor: x.usadoPct == null ? null : x.usadoPct / 100 }) as Bloque),
    { tipo: 'tabla', columnas: ['agente', 'usado %', 'sesión %', 'presupuesto %', 'modo', 'retraso min'], filas: ags.map(([a, x]) => [a, x.usadoPct, x.usadoSesionPct, x.presupuestoPct, x.modo, x.retrasoMin]) },
    { tipo: 'texto', lineas: [`burn ${d.burn ?? '—'} · agotamiento proyectado ${d.agotamiento ?? '—'} · ${d.en_vuelo?.length ?? 0} tareas en vuelo`] },
  ] };
}

export function panelEstado(modo: { modo: string }, ps: Proveedor[], d: EstadoDosificador | null, borradores: unknown[], tareas: Tarea[]): Panel {
  const pend = tareas.filter((t) => t.classification?.requires_human_review).length;
  return { origen: 'control', titulo: 'Control · estado', subtitulo: `Karajan en ${modo.modo.toUpperCase()}`, datos: { modo, proveedores: ps, dosificador: d, borradores: borradores.length, revisiones: pend }, bloques: [
    { tipo: 'tabla', columnas: ['panel', 'valor'], filas: [['modo', modo.modo], ['proveedores listos', `${ps.filter((p) => p.disponible).length}/${ps.length}`], ['dosificador', d ? d.modo : 'sin dato'], ['borradores abiertos', borradores.length], ['esperan revisión humana', pend]] },
    ...(d ? Object.entries(d.agentes ?? {}).map(([a, x]) => ({ tipo: 'medidor', titulo: `cuota ${a}`, valor: x.usadoPct == null ? null : x.usadoPct / 100 }) as Bloque) : []),
  ] };
}

interface Clasif { complexity_level?: number | string; domain?: string[]; intent?: string; complexity_score?: number; recommended_model?: string; recommended_skills?: string[]; requires_human_review?: boolean; reason?: string; criteria?: Record<string, number>; subtasks?: { title?: string; name?: string }[] }
interface Plan { task_id?: string; status?: string; clasificacion: Clasif; asignaciones?: { subtarea: string; nombre: string; proveedor: string; modelo: string; regla: string | null; motivo: string }[]; bloqueada?: string | null }

export function panelMision(prompt: string, plan: Plan, ejecutada: boolean): Panel {
  const c = plan.clasificacion;
  return { origen: 'control', titulo: ejecutada ? 'Control · misión delegada' : 'Control · misión (plan, sin ejecutar)', subtitulo: `N${c.complexity_level ?? '?'} · ${(c.domain ?? []).join(', ')} · ${c.intent ?? ''}`, datos: plan, bloques: [
    { tipo: 'texto', titulo: 'Entrada', lineas: [prompt.slice(0, 300)] },
    { tipo: 'barras', titulo: 'Criterios (0-5)', filas: Object.entries(c.criteria ?? {}).map(([k, v]) => ({ etiqueta: k, valor: v })) },
    { tipo: 'tabla', titulo: 'Asignación', columnas: ['subtarea', 'agente', 'modelo', 'regla', 'motivo'], filas: (plan.asignaciones ?? []).map((a) => [a.nombre || a.subtarea, a.proveedor, a.modelo, a.regla, a.motivo]) },
    { tipo: 'texto', lineas: [`Skills: ${(c.recommended_skills ?? []).join(', ') || '—'}`, `Revisión humana: ${c.requires_human_review ? 'SÍ' : 'no'}`, ...(plan.bloqueada ? [`BLOQUEADA: ${plan.bloqueada}`] : []), ...(c.reason ? [c.reason] : [])] },
  ] };
}

export const comandosControl: Comando[] = [
  { ruta: ['control', 'estado'], resumen: 'modo, proveedores, cuota, borradores y revisiones de un vistazo', ejecutar: async (ctx) => {
    const [modo, ps, d, b, t] = await Promise.all([ctx.pedir('/laboratorio/modo') as Promise<{ modo: string }>, cola<Proveedor[]>(ctx, '/providers', []), cola<EstadoDosificador | null>(ctx, '/dosificador/estado', null), cola<unknown[]>(ctx, '/laboratorio/propuestas', []), cola<Tarea[]>(ctx, '/tasks?limit=100', [])]);
    return panelEstado(modo, ps, d, Array.isArray(b) ? b : [], t);
  } },
  { ruta: ['control', 'mapa'], resumen: 'equipos por zona con su carga, cuota y actividad reciente', ejecutar: async (ctx) => {
    const [l, r, d, t] = await Promise.all([ctx.pedir('/routing-layout') as Promise<Layout>, cola<Rendimiento[]>(ctx, '/agents/performance', []), cola<EstadoDosificador | null>(ctx, '/dosificador/estado', null), cola<Tarea[]>(ctx, '/tasks?limit=8', [])]);
    return panelMapa(l, r, d, t);
  } },
  { ruta: ['control', 'jerarquia'], uso: 'control jerarquia [--perfil <id>]', resumen: 'árbol de agentes y reglas de enrutado', ejecutar: async (ctx) => panelJerarquia((await ctx.pedir('/routing-layout')) as Layout, ctx.opcion('perfil')) },
  { ruta: ['control', 'perfiles'], resumen: 'perfiles de enrutado (el que ejecuta y el que se edita)', ejecutar: async (ctx) => panelPerfiles((await ctx.pedir('/routing-layout')) as Layout) },
  { ruta: ['control', 'proveedores'], resumen: 'Claude Code, Codex, Qwen…: cuáles están listos', ejecutar: async (ctx) => panelProveedores((await ctx.pedir('/providers')) as Proveedor[]) },
  { ruta: ['control', 'revisiones'], resumen: 'tareas que esperan revisión humana', ejecutar: async (ctx) => panelRevisiones((await ctx.pedir('/tasks?limit=200')) as Tarea[]) },
  { ruta: ['control', 'cuota'], resumen: 'cuota de cada agente y modo del dosificador', ejecutar: async (ctx) => panelCuota((await ctx.pedir('/dosificador/estado')) as EstadoDosificador) },
  { ruta: ['control', 'mision'], uso: 'control mision "<texto>" [--ejecutar]', resumen: 'clasifica y planifica una tarea; con --ejecutar la delega de verdad', ejecutar: async (ctx, args) => {
    const prompt = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--perfil').join(' ').trim();
    if (!prompt) throw new Error('uso: kj control mision "<texto>" [--ejecutar]');
    const ejecutar = ctx.bandera('ejecutar');
    return panelMision(prompt, (await ctx.pedir(ejecutar ? '/delegate-task' : '/routing/plan', 'POST', { prompt })) as Plan, ejecutar);
  } },
];
