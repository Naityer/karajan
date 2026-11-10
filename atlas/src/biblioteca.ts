import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/**
 * Biblioteca de recursos de Karajan (`resources.db` del Karajan nativo), en SOLO LECTURA: ficha de una skill (descripción,
 * estrellas, repo, grupo de la taxonomía) y búsqueda por texto. La escriben el refresco y la ingesta del Karajan nativo; aquí no.
 *
 * Las estrellas de una skill anidada (hija de una colección) son las del repo padre: se marcan `heredadas`, porque no dicen nada
 * de esa skill en concreto (todas las de superpowers «tienen» las estrellas de la colección que las recoge).
 */
export interface FichaRecurso {
  nombre: string; slug: string; tipo: string; descripcion: string; estrellas: number | null; heredadas: boolean;
  repo_url: string | null; grupo: string | null; capacidades: string[];
  /** Etiquetas declaradas (`tags_json`) y casos de uso del análisis de la ingesta: palabras clave, no una evaluación. */
  etiquetas: string[]; usos: string[];
}

/** Las estrellas del propio recurso: null si no hay dato o si son las de la colección que lo recoge. */
export const estrellasPropias = (f: Pick<FichaRecurso, 'estrellas' | 'heredadas'>): number | null => (f.estrellas !== null && !f.heredadas ? f.estrellas : null);


/** Resumen de un recurso para el catálogo de Inspiration (lo que muestran la lista, el árbol y el detalle). */
export interface ResumenRecurso {
  id: string; slug: string; nombre: string; tipo: string; origen: string; estado: string; indexado: string; padre: string | null;
  grupo: string | null; estrellas: number | null; heredadas: boolean; runtimes: string[]; capacidades: string[]; etiquetas: string[];
  instalaciones: number; validez: string | null; motivos_validez: string[]; resumen: string; repo_url: string | null;
}
export interface GrupoRecurso { id: string; nombre: string; descripcion: string; padre: string | null; orden: number; recursos: number }
export interface FiltroRecursos { grupo?: string; tipo?: string; estado?: string; runtime?: string; origen?: string; validez?: string; q?: string; limite?: number; desplazamiento?: number }
export interface FuenteRadar { id: string; nombre: string; url: string; proveedor: string; tipo: string; activa: boolean; disponible: boolean; requiere_credenciales: boolean; pista: string | null }

/** Consultas comunes a los adaptadores HTTP y local. Nunca modifica la biblioteca. */
export function consultarBiblioteca(biblioteca: Biblioteca, ruta: string, query: Record<string, string | undefined> = {}): unknown {
  const error = (status: number, detail: string): never => { throw Object.assign(new Error(detail), { status }); };
  if (!biblioteca.disponible) return error(409, 'La biblioteca necesita resources.db (ATLAS_KARAJAN_RESOURCES).');
  const texto = (v: string | undefined) => v?.trim() ? v.trim().slice(0, 200) : undefined;
  const entero = (v: string | undefined, def: number, min: number, max: number) => v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : def;
  if (ruta === '/resources') return biblioteca.listar({ grupo: texto(query['group']), tipo: texto(query['kind']), estado: texto(query['status']), runtime: texto(query['runtime']), origen: texto(query['source']), validez: texto(query['validity']), q: texto(query['q']), limite: entero(query['limit'], 100, 1, 500), desplazamiento: entero(query['offset'], 0, 0, 1_000_000) });
  if (ruta === '/resources/index') return biblioteca.recuentos();
  if (ruta === '/resources/discovery/sources') return { fuentes: biblioteca.fuentes() };
  if (ruta === '/resources/review') return biblioteca.listar({ validez: texto(query['state']) ?? 'pending_review', limite: 500 });
  if (ruta === '/resources/validity-policy' || ruta === '/resources/refresh/settings') {
    const re = ruta === '/resources/validity-policy' ? /valid|polic/i : /refresh|cadenc|schedule/i;
    return { preferencias: Object.fromEntries(Object.entries(biblioteca.preferencias()).filter(([k]) => re.test(k))) };
  }
  if (ruta === '/resource-groups') return biblioteca.grupos();
  if (ruta.startsWith('/resources/')) return biblioteca.detalle(decodeURIComponent(ruta.slice('/resources/'.length))) ?? error(404, 'recurso no encontrado');
  return error(404, `Consulta no disponible: ${ruta}`);
}

type Fila = Record<string, unknown>;
const json = <T,>(v: unknown, defecto: T): T => { try { return typeof v === 'string' ? (JSON.parse(v) as T) : defecto; } catch { return defecto; } };

export class Biblioteca {
  private readonly db: DatabaseSync | null;
  private readonly estricto: boolean;

  constructor(ruta: string | null, opciones: { estricto?: boolean } = {}) {
    this.estricto = opciones.estricto === true;
    this.db = ruta && existsSync(ruta) ? new DatabaseSync(ruta, { readOnly: true }) : null;
  }

  get disponible(): boolean { return this.db !== null; }
  cerrar(): void { try { this.db?.close(); } catch { /* ya cerrada */ } }

  private todas(sql: string, ...p: (string | number)[]): Fila[] {
    if (!this.db) return [];
    try { return this.db.prepare(sql).all(...p) as Fila[]; }
    catch (err) { if (this.estricto) throw err; return []; }
  }

  private ficha(f: Fila): FichaRecurso {
    const meta = json<Record<string, unknown>>(f['metadata_json'], {});
    const tax = meta['decision_taxonomy'] as { group_id?: string } | undefined;
    const intel = meta['intelligence'] as { capabilities?: string[]; use_cases?: string[] } | undefined;
    const heredadas = f['parent_resource_id'] !== null && f['parent_resource_id'] !== undefined;
    const estrellas = typeof meta['github_stars'] === 'number' ? (meta['github_stars'] as number) : null;
    const repo = (f['repo_url'] as string | null) ?? (f['source_url'] as string | null) ?? (f['padre_repo'] as string | null) ?? (typeof meta['html_url'] === 'string' ? (meta['html_url'] as string) : null);
    return {
      nombre: String(f['name']), slug: String(f['slug']), tipo: String(f['kind']),
      descripcion: String(f['summary'] ?? '').replace(/^﻿/, '').replace(/^---[\s\S]*?description:\s*/, '').replace(/\s*---\s*$/, '').slice(0, 400),
      estrellas, heredadas: heredadas && estrellas !== null, repo_url: repo, grupo: tax?.group_id ?? null,
      capacidades: [...new Set([...(intel?.capabilities ?? []), ...json<string[]>(f['capabilities_json'], [])])].slice(0, 30),
      etiquetas: json<string[]>(f['tags_json'], []).slice(0, 60), usos: (intel?.use_cases ?? []).filter((u) => typeof u === 'string').slice(0, 20),
    };
  }

  private static readonly SELECT = `SELECT r.*, p.repo_url AS padre_repo FROM resources r LEFT JOIN resources p ON p.id = r.parent_resource_id`;

  /** La ficha de una skill por su nombre de carpeta: primero la skill exacta, si no la capacidad (repo) con ese slug. */
  fichaDe(nombre: string): FichaRecurso | null {
    const f = this.todas(`${Biblioteca.SELECT} WHERE r.index_status = 'active' AND (r.slug = ? OR r.name = ? OR r.slug LIKE ?)
      ORDER BY CASE WHEN r.slug = ? THEN 0 WHEN r.name = ? THEN 1 ELSE 2 END, CASE r.kind WHEN 'skill' THEN 0 WHEN 'capability' THEN 1 ELSE 2 END LIMIT 1`,
    nombre, nombre, `%--${nombre}`, nombre, nombre)[0];
    return f ? this.ficha(f) : null;
  }

  /** Búsqueda por texto (FTS5 si está, por relevancia; si no, LIKE), solo skills y capacidades activas. */
  buscar(q: string, limite = 20): FichaRecurso[] {
    const terminos = (q.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2).slice(0, 8);
    if (!terminos.length) return [];
    const fts = this.todas(`SELECT resource_id AS id FROM resource_fts_v2 WHERE resource_fts_v2 MATCH ? ORDER BY rank LIMIT ?`, terminos.map((t) => `"${t}"*`).join(' AND '), limite * 3);
    const filas = fts.length
      ? this.todas(`${Biblioteca.SELECT} WHERE r.id IN (${fts.map(() => '?').join(',')}) AND r.kind != 'reference' AND r.index_status = 'active'`, ...fts.map((f) => String(f['id'])))
      : this.todas(`${Biblioteca.SELECT} WHERE r.kind != 'reference' AND r.index_status = 'active' AND ${terminos.map(() => '(lower(r.name) LIKE ? OR lower(r.summary) LIKE ?)').join(' AND ')} LIMIT ?`,
        ...terminos.flatMap((t) => [`%${t}%`, `%${t}%`]), limite * 3);
    const orden = new Map(fts.map((f, i) => [String(f['id']), i]));
    return filas.sort((a, b) => (orden.get(String(a['id'])) ?? 0) - (orden.get(String(b['id'])) ?? 0)).slice(0, limite).map((f) => this.ficha(f));
  }

  /** Skills y capacidades activas de un grupo de la taxonomía (`decision_taxonomy.group_id`), con sus estrellas y si son propias o heredadas. */
  listarGrupo(grupo: string): FichaRecurso[] {
    return this.todas(`${Biblioteca.SELECT} WHERE r.kind != 'reference' AND r.index_status = 'active' AND json_extract(r.metadata_json, '$.decision_taxonomy.group_id') = ?`, grupo).map((f) => this.ficha(f));
  }

  /** Nombre legible de un grupo (`resource_groups`); el propio id si la tabla no está. */
  nombreGrupo(grupo: string): string {
    return String(this.todas('SELECT name FROM resource_groups WHERE id = ?', grupo)[0]?.['name'] ?? grupo);
  }

  /** Qué fracción de las fichas activas declara cada etiqueta o capacidad: las de la ingesta que casi todas comparten («testing», «deployment») no distinguen nada. */
  frecuenciasTerminos(): Map<string, number> {
    const filas = this.todas(`SELECT tags_json, capabilities_json FROM resources WHERE kind != 'reference' AND index_status = 'active'`);
    const veces = new Map<string, number>();
    for (const f of filas) for (const t of new Set([...json<string[]>(f['tags_json'], []), ...json<string[]>(f['capabilities_json'], [])].map((x) => String(x).trim().toLowerCase()))) veces.set(t, (veces.get(t) ?? 0) + 1);
    return new Map([...veces].map(([t, n]) => [t, n / (filas.length || 1)]));
  }

  private resumen(f: Fila): ResumenRecurso {
    const meta = json<Record<string, unknown>>(f['metadata_json'], {});
    const val = meta['validity'] as { state?: string; reasons?: string[] } | undefined;
    const base = this.ficha(f);
    return {
      id: String(f['id']), slug: base.slug, nombre: base.nombre, tipo: base.tipo, origen: String(f['source'] ?? ''), estado: String(f['status'] ?? ''), indexado: String(f['index_status'] ?? ''),
      padre: (f['parent_resource_id'] as string | null) ?? null, grupo: (f['grupo_id'] as string | null) ?? null, estrellas: base.estrellas, heredadas: base.heredadas,
      runtimes: json<string[]>(f['compatible_runtimes_json'], []), capacidades: base.capacidades, etiquetas: base.etiquetas,
      instalaciones: json<unknown[]>(f['installations_json'], []).length, validez: val?.state ?? null, motivos_validez: val?.reasons ?? [], resumen: base.descripcion, repo_url: base.repo_url,
    };
  }

  private static readonly SELECT_GRUPO = `SELECT r.*, p.repo_url AS padre_repo, a.group_id AS grupo_id FROM resources r LEFT JOIN resources p ON p.id = r.parent_resource_id LEFT JOIN resource_group_assignments a ON a.resource_id = r.id`;

  /** Catálogo con filtros (tipo, estado, runtime, origen, validez y texto), activos primero por nombre. */
  listar(f: FiltroRecursos = {}): ResumenRecurso[] {
    const donde: string[] = ["r.index_status = 'active'"], par: (string | number)[] = [];
    if (f.grupo) { const gs = f.grupo.split(',').filter(Boolean).slice(0, 100); donde.push(`a.group_id IN (${gs.map(() => '?').join(',')})`); par.push(...gs); }
    if (f.tipo) { donde.push('r.kind = ?'); par.push(f.tipo); }
    if (f.estado) { donde.push('r.status = ?'); par.push(f.estado); }
    if (f.origen) { donde.push('r.source = ?'); par.push(f.origen); }
    if (f.runtime) { donde.push('r.compatible_runtimes_json LIKE ?'); par.push(`%"${f.runtime}"%`); }
    if (f.validez) { donde.push("json_extract(r.metadata_json, '$.validity.state') = ?"); par.push(f.validez); }
    if (f.q?.trim()) { donde.push('(lower(r.name) LIKE ? OR lower(r.summary) LIKE ? OR lower(r.tags_json) LIKE ?)'); const x = `%${f.q.trim().toLowerCase()}%`; par.push(x, x, x); }
    return this.todas(`${Biblioteca.SELECT_GRUPO} WHERE ${donde.join(' AND ')} ORDER BY r.name COLLATE NOCASE LIMIT ? OFFSET ?`, ...par, Math.min(500, Math.max(1, f.limite ?? 100)), Math.max(0, f.desplazamiento ?? 0)).map((x) => this.resumen(x));
  }

  /** El recurso por id o slug, con sus hijos y las últimas operaciones. */
  detalle(idOSlug: string): { recurso: ResumenRecurso; hijos: ResumenRecurso[]; operaciones: { accion: string; estado: string; detalle: string; creada: string }[]; descripcion: string } | null {
    const fila = this.todas(`${Biblioteca.SELECT_GRUPO} WHERE r.id = ? OR r.slug = ? ORDER BY CASE r.kind WHEN 'skill' THEN 0 WHEN 'capability' THEN 1 ELSE 2 END LIMIT 1`, idOSlug, idOSlug)[0];
    if (!fila) return null;
    const id = String(fila['id']);
    return {
      recurso: this.resumen(fila), descripcion: String(fila['summary'] ?? '').slice(0, 1500),
      hijos: this.todas(`${Biblioteca.SELECT_GRUPO} WHERE r.parent_resource_id = ? AND r.index_status = 'active' ORDER BY r.name COLLATE NOCASE LIMIT 200`, id).map((x) => this.resumen(x)),
      operaciones: this.todas('SELECT action, status, detail, created_at FROM resource_operations WHERE resource_id = ? ORDER BY created_at DESC LIMIT 10', id).map((o) => ({ accion: String(o['action']), estado: String(o['status']), detalle: String(o['detail'] ?? '').slice(0, 200), creada: String(o['created_at']) })),
    };
  }

  /** Grupos de la taxonomía (con jerarquía) y cuántos recursos tiene cada uno. */
  grupos(): GrupoRecurso[] {
    return this.todas(`SELECT g.id, g.name, g.description, g.parent_id, g.sort_order, (SELECT count(*) FROM resource_group_assignments a WHERE a.group_id = g.id) AS n FROM resource_groups g ORDER BY g.sort_order, g.name COLLATE NOCASE`)
      .map((g) => ({ id: String(g['id']), nombre: String(g['name']), descripcion: String(g['description'] ?? ''), padre: (g['parent_id'] as string | null) ?? null, orden: Number(g['sort_order'] ?? 0), recursos: Number(g['n'] ?? 0) }));
  }

  /** Recuentos para el panel de entrada: por tipo, estado, validez y origen. */
  recuentos(): { tipo: Record<string, number>; estado: Record<string, number>; validez: Record<string, number>; origen: Record<string, number>; total: number } {
    const por = (col: string) => Object.fromEntries(this.todas(`SELECT ${col} AS k, count(*) AS n FROM resources WHERE index_status = 'active' GROUP BY ${col}`).map((x) => [String(x['k'] ?? 'sin dato'), Number(x['n'])]));
    return { tipo: por('kind'), estado: por('status'), origen: por('source'), validez: por("json_extract(metadata_json, '$.validity.state')"), total: Number(this.todas("SELECT count(*) AS n FROM resources WHERE index_status = 'active'")[0]?.['n'] ?? 0) };
  }

  /** Fuentes de descubrimiento (el radar). */
  fuentes(): FuenteRadar[] {
    return this.todas('SELECT * FROM discovery_sources ORDER BY name COLLATE NOCASE').map((s) => ({ id: String(s['id']), nombre: String(s['name']), url: String(s['url']), proveedor: String(s['provider']), tipo: String(s['source_type']), activa: !!s['enabled'], disponible: !!s['available'], requiere_credenciales: !!s['requires_credentials'], pista: (s['setup_hint'] as string | null) ?? null }));
  }

  /** Preferencias guardadas (política de validez, ajustes de refresco…), sin interpretar. */
  preferencias(): Record<string, unknown> {
    return Object.fromEntries(this.todas('SELECT preference_key, value_json FROM resource_preferences').map((r) => [String(r['preference_key']), json<unknown>(r['value_json'], null)]));
  }
}
