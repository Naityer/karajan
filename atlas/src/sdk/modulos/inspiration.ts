import type { NodoArbol } from '../ascii';
import { argumentosPosicionales, type Comando, type Contexto } from '../comandos';
import type { Bloque, Panel } from '../panel';

/**
 * Módulo Inspiration (fachada): la biblioteca de recursos (skills, capacidades y referencias) como la veía el operador —
 * catálogo, árbol de familias, grupos, radar de descubrimiento y cola de revisión— sobre el componente `biblioteca`, en solo
 * lectura. Altas, instalación, revisión y refresco siguen siendo del Karajan nativo.
 */
interface Recurso { id: string; slug: string; nombre: string; tipo: string; origen: string; estado: string; indexado: string; padre: string | null; grupo: string | null; estrellas: number | null; heredadas: boolean; runtimes: string[]; capacidades: string[]; etiquetas: string[]; instalaciones: number; validez: string | null; motivos_validez: string[]; resumen: string; repo_url: string | null }
interface Grupo { id: string; nombre: string; descripcion: string; padre: string | null; orden: number; recursos: number }
interface Recuentos { tipo: Record<string, number>; estado: Record<string, number>; validez: Record<string, number>; origen: Record<string, number>; total: number }
interface Fuente { id: string; nombre: string; url: string; proveedor: string; tipo: string; activa: boolean; disponible: boolean; requiere_credenciales: boolean; pista: string | null }
interface Detalle { recurso: Recurso; descripcion: string; hijos: Recurso[]; operaciones: { accion: string; estado: string; detalle: string; creada: string }[] }

const ordenado = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([etiqueta, valor]) => ({ etiqueta, valor }));
const estrellas = (r: Pick<Recurso, 'estrellas' | 'heredadas'>) => (r.estrellas === null ? null : `${r.estrellas}★${r.heredadas ? '*' : ''}`);
const consulta = (ctx: Contexto, nombres: [opcion: string, parametro: string][]) => {
  const q = nombres.flatMap(([o, p]) => { const v = ctx.opcion(o); return v ? [`${p}=${encodeURIComponent(v)}`] : []; });
  return q.length ? `?${q.join('&')}` : '';
};

export function panelResumen(c: Recuentos, grupos: Grupo[]): Panel {
  return { origen: 'inspiration', titulo: 'Inspiration · resumen', subtitulo: `${c.total} recursos activos`, datos: { recuentos: c, grupos }, bloques: [
    { tipo: 'barras', titulo: 'Por tipo', filas: ordenado(c.tipo) },
    { tipo: 'barras', titulo: 'Por estado', filas: ordenado(c.estado) },
    { tipo: 'barras', titulo: 'Validez de la fuente', filas: ordenado(c.validez) },
    { tipo: 'barras', titulo: 'Por origen', filas: ordenado(c.origen).slice(0, 10) },
    { tipo: 'barras', titulo: 'Grupos con más recursos', filas: [...grupos].sort((a, b) => b.recursos - a.recursos).slice(0, 10).map((g) => ({ etiqueta: g.nombre, valor: g.recursos })) },
  ] };
}

export function panelLista(rs: Recurso[], filtros: string): Panel {
  return { origen: 'inspiration', titulo: 'Inspiration · catálogo', subtitulo: `${rs.length} recursos${filtros ? ` · ${filtros}` : ''}`, datos: rs, bloques: [
    { tipo: 'tabla', columnas: ['nombre', 'tipo', 'estado', 'estrellas', 'runtimes', 'validez', 'origen'], filas: rs.map((r) => [r.nombre, r.tipo, r.estado, estrellas(r), r.runtimes.join(','), r.validez, r.origen]) },
    { tipo: 'texto', lineas: ['★* = estrellas heredadas del repositorio que recoge la skill.'] },
  ] };
}

/** Familia → grupo → artefacto → componentes (el «Árbol» de Inspiration). Los grupos hijos cuelgan de su padre. */
const MAX_HIJOS = 12;
const topeHijos = (hs: NodoArbol[]): NodoArbol[] => (hs.length > MAX_HIJOS ? [...hs.slice(0, MAX_HIJOS), { nombre: `… y ${hs.length - MAX_HIJOS} más` }] : hs);
export const descendientes = (grupos: Grupo[], id: string): string[] => [id, ...grupos.filter((g) => g.padre === id).flatMap((g) => descendientes(grupos, g.id))];
export function panelArbol(grupos: Grupo[], rs: Recurso[], solo: string | null): Panel {
  const hijosDe = (id: string) => rs.filter((r) => r.padre === id);
  const nodoRecurso = (r: Recurso): NodoArbol => ({ nombre: r.nombre, nota: [r.tipo, estrellas(r), r.estado === 'installed' ? 'instalado' : ''].filter(Boolean).join(' · '), hijos: topeHijos(hijosDe(r.id).map((h) => ({ nombre: h.nombre, nota: h.tipo }))) });
  const nodoGrupo = (g: Grupo, visto: Set<string>): NodoArbol => ({
    nombre: g.nombre, nota: `(${g.recursos})`,
    hijos: [...grupos.filter((h) => h.padre === g.id && !visto.has(h.id)).map((h) => nodoGrupo(h, new Set([...visto, g.id]))), ...rs.filter((r) => r.grupo === g.id && !r.padre).map(nodoRecurso)],
  });
  const ids = new Set(grupos.map((g) => g.id));
  const elegido = solo ? grupos.find((g) => g.id === solo || g.nombre.toLowerCase() === solo.toLowerCase()) : null;
  const raices = elegido ? [elegido] : grupos.filter((g) => !g.padre || !ids.has(g.padre));
  const sin = rs.filter((r) => !r.grupo && !r.padre);
  const hijos = [...raices.map((g) => nodoGrupo(g, new Set([g.id]))), ...(!solo && sin.length ? [{ nombre: 'Sin grupo', nota: `(${sin.length})`, hijos: sin.slice(0, 30).map(nodoRecurso) } as NodoArbol] : [])];
  return { origen: 'inspiration', titulo: 'Inspiration · árbol', subtitulo: solo ? `grupo ${solo}` : `${rs.length} recursos`, datos: { grupos, recursos: rs.length }, bloques: [{ tipo: 'arbol', raiz: { nombre: 'Biblioteca', hijos } }] };
}

export function panelGrupos(grupos: Grupo[]): Panel {
  const hijosDe = (id: string | null, visto: Set<string>): NodoArbol[] => grupos.filter((g) => g.padre === id && !visto.has(g.id)).map((g) => ({ nombre: g.nombre, nota: `(${g.recursos})${g.descripcion ? ` ${g.descripcion.slice(0, 60)}` : ''}`, hijos: hijosDe(g.id, new Set([...visto, g.id])) }));
  const ids = new Set(grupos.map((g) => g.id));
  const raices = grupos.filter((g) => !g.padre || !ids.has(g.padre));
  return { origen: 'inspiration', titulo: 'Inspiration · grupos', subtitulo: `${grupos.length} grupos`, datos: grupos, bloques: [{ tipo: 'arbol', raiz: { nombre: 'Taxonomía', hijos: raices.map((g) => ({ nombre: g.nombre, nota: `(${g.recursos})`, hijos: hijosDe(g.id, new Set([g.id])) })) } }] };
}

export function panelVer(d: Detalle): Panel {
  const r = d.recurso;
  return { origen: 'inspiration', titulo: `Inspiration · ${r.nombre}`, subtitulo: `${r.tipo} · ${r.estado}`, datos: d, bloques: [
    { tipo: 'texto', lineas: [d.descripcion || r.resumen || '(sin descripción)'] },
    { tipo: 'tabla', columnas: ['campo', 'valor'], filas: [['id', r.id], ['origen', r.origen], ['repositorio', r.repo_url], ['estrellas', estrellas(r)], ['grupo', r.grupo], ['runtimes', r.runtimes.join(', ')], ['instalaciones', r.instalaciones], ['validez', r.validez], ['capacidades', r.capacidades.slice(0, 8).join(', ')], ['etiquetas', r.etiquetas.slice(0, 8).join(', ')]] },
    ...(r.motivos_validez.length ? [{ tipo: 'texto', titulo: 'Por qué espera revisión', lineas: r.motivos_validez } as Bloque] : []),
    ...(d.hijos.length ? [{ tipo: 'tabla', titulo: `Componentes (${d.hijos.length})`, columnas: ['nombre', 'tipo', 'estado'], filas: d.hijos.map((h) => [h.nombre, h.tipo, h.estado]) } as Bloque] : []),
    ...(d.operaciones.length ? [{ tipo: 'tabla', titulo: 'Últimas operaciones', columnas: ['acción', 'estado', 'detalle', 'cuándo'], filas: d.operaciones.map((o) => [o.accion, o.estado, o.detalle, o.creada.slice(0, 16)]) } as Bloque] : []),
  ] };
}

export function panelRadar(fs: Fuente[]): Panel {
  return { origen: 'inspiration', titulo: 'Inspiration · radar', subtitulo: `${fs.filter((f) => f.activa).length} de ${fs.length} fuentes activas`, datos: fs, bloques: [{ tipo: 'tabla', columnas: ['fuente', 'proveedor', 'tipo', 'activa', 'disponible', 'credenciales', 'pista'], filas: fs.map((f) => [f.nombre, f.proveedor, f.tipo, f.activa ? 'sí' : 'no', f.disponible ? 'sí' : 'no', f.requiere_credenciales ? 'sí' : 'no', f.pista]) }] };
}

export function panelRevision(rs: Recurso[], sinEvaluar = 0): Panel {
  return { origen: 'inspiration', titulo: 'Inspiration · revisión', subtitulo: `${rs.length} esperan decisión`, datos: rs, bloques: [
    { tipo: 'tabla', columnas: ['recurso', 'tipo', 'estrellas', 'motivos'], filas: rs.map((r) => [r.nombre, r.tipo, estrellas(r), r.motivos_validez.join('; ')]) },
    { tipo: 'texto', lineas: ['Aceptar o descartar se hace en el Karajan nativo (en producción, con una tarea aceptada).', ...(sinEvaluar ? [`Ojo: ${sinEvaluar} recursos no tienen estado de validez guardado; lo evalúa el Karajan nativo al leerlos, así que aquí no pueden aparecer como pendientes.`] : [])] },
  ] };
}

const aplanar = (pref: Record<string, unknown>) => Object.entries(pref).flatMap(([k, v]) => (v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>).map(([c2, x]) => [`${k}.${c2}`, Array.isArray(x) ? x.join(', ') : String(x)]) : [[k, String(v)]]));

export function panelValidez(pref: Record<string, unknown>, c: Recuentos): Panel {
  const pol = aplanar(pref);
  return { origen: 'inspiration', titulo: 'Inspiration · validez', datos: { preferencias: pref, validez: c.validez }, bloques: [
    { tipo: 'barras', titulo: 'Recursos por estado de validez', filas: ordenado(c.validez) },
    ...(pol.length ? [{ tipo: 'tabla', titulo: 'Política guardada', columnas: ['clave', 'valor'], filas: pol } as Bloque] : [{ tipo: 'texto', titulo: 'Política', lineas: ['No hay política guardada: se usa la de por defecto del Karajan nativo, y «sin dato» significa que aún no se ha evaluado ese recurso.'] } as Bloque]),
  ] };
}

export function panelRefresco(pref: Record<string, unknown>): Panel {
  const estado = (Object.entries(pref).find(([k]) => /status/.test(k))?.[1] ?? {}) as Record<string, unknown>;
  const ejecucion = (Object.entries(pref).find(([k]) => /run/.test(k))?.[1] ?? {}) as Record<string, unknown>;
  return { origen: 'inspiration', titulo: 'Inspiration · refresco', subtitulo: ejecucion['status'] ? `última ejecución ${ejecucion['status']}` : undefined, datos: pref, bloques: [
    { tipo: 'tabla', titulo: 'Último refresco', columnas: ['dato', 'valor'], filas: [['cuándo', String(estado['last_run_at'] ?? '').slice(0, 16) || null], ['analizados', (estado['last_analyzed'] as number) ?? null], ['actualizados', (estado['last_updated'] as number) ?? null], ['fallidos', (estado['last_failed'] as number) ?? null]] },
    ...(ejecucion['total'] ? [{ tipo: 'medidor', titulo: `Ejecución ${ejecucion['status']} · ${ejecucion['processed']} de ${ejecucion['total']}`, valor: Number(ejecucion['processed']), max: Number(ejecucion['total']) } as Bloque] : []),
  ] };
}

export const comandosInspiration: Comando[] = [
  { ruta: ['inspiration', 'resumen'], resumen: 'recuentos por tipo, estado, validez, origen y grupo', ejecutar: async (ctx) => panelResumen((await ctx.pedir('/resources/index')) as Recuentos, (await ctx.pedir('/resource-groups')) as Grupo[]) },
  { ruta: ['inspiration', 'lista'], uso: 'inspiration lista [--tipo skill|capability|reference] [--estado e] [--runtime r] [--origen o] [--validez v] [--buscar texto] [--limite N]', resumen: 'catálogo con filtros', ejecutar: async (ctx) => {
    const q = consulta(ctx, [['tipo', 'kind'], ['estado', 'status'], ['runtime', 'runtime'], ['origen', 'source'], ['validez', 'validity'], ['buscar', 'q'], ['limite', 'limit']]);
    return panelLista((await ctx.pedir(`/resources${q}`)) as Recurso[], decodeURIComponent(q.slice(1)).replace(/&/g, ' · '));
  } },
  { ruta: ['inspiration', 'arbol'], uso: 'inspiration arbol [--grupo <id|nombre>]', resumen: 'familia → grupo → artefacto → componentes', ejecutar: async (ctx) => {
    const gs = (await ctx.pedir('/resource-groups')) as Grupo[], solo = ctx.opcion('grupo');
    const g = solo ? gs.find((x) => x.id === solo || x.nombre.toLowerCase() === solo.toLowerCase()) : null;
    if (solo && !g) throw new Error(`grupo desconocido: ${solo}`);
    const rs = (await ctx.pedir(`/resources?limit=500${g ? `&group=${descendientes(gs, g.id).join(',')}` : ''}`)) as Recurso[];
    return panelArbol(gs, rs, solo);
  } },
  { ruta: ['inspiration', 'grupos'], resumen: 'taxonomía de grupos con su número de recursos', ejecutar: async (ctx) => panelGrupos((await ctx.pedir('/resource-groups')) as Grupo[]) },
  { ruta: ['inspiration', 'ver'], uso: 'inspiration ver <id|slug>', resumen: 'ficha de un recurso: datos, componentes y operaciones', ejecutar: async (ctx, args) => {
    const id = argumentosPosicionales(args)[0];
    if (!id) throw new Error('uso: kj inspiration ver <id|slug>');
    return panelVer((await ctx.pedir(`/resources/${encodeURIComponent(id)}`)) as Detalle);
  } },
  { ruta: ['inspiration', 'radar'], resumen: 'fuentes de descubrimiento', ejecutar: async (ctx) => panelRadar(((await ctx.pedir('/resources/discovery/sources')) as { fuentes: Fuente[] }).fuentes) },
  { ruta: ['inspiration', 'revision'], resumen: 'recursos que esperan aceptar o descartar', ejecutar: async (ctx) => {
    const [rs, c] = await Promise.all([ctx.pedir('/resources/review') as Promise<Recurso[]>, ctx.pedir('/resources/index') as Promise<Recuentos>]);
    return panelRevision(rs, c.validez['sin dato'] ?? 0);
  } },
  { ruta: ['inspiration', 'refresco'], resumen: 'estado del último refresco de la biblioteca', ejecutar: async (ctx) => panelRefresco(((await ctx.pedir('/resources/refresh/settings')) as { preferencias: Record<string, unknown> }).preferencias) },
  { ruta: ['inspiration', 'validez'], resumen: 'política de validez de las fuentes y su efecto', ejecutar: async (ctx) => panelValidez(((await ctx.pedir('/resources/validity-policy')) as { preferencias: Record<string, unknown> }).preferencias, (await ctx.pedir('/resources/index')) as Recuentos) },
];
