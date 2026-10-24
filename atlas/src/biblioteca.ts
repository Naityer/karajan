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

type Fila = Record<string, unknown>;
const json = <T,>(v: unknown, defecto: T): T => { try { return typeof v === 'string' ? (JSON.parse(v) as T) : defecto; } catch { return defecto; } };

export class Biblioteca {
  private readonly db: DatabaseSync | null;

  constructor(ruta: string | null) {
    this.db = ruta && existsSync(ruta) ? new DatabaseSync(ruta, { readOnly: true }) : null;
  }

  get disponible(): boolean { return this.db !== null; }
  cerrar(): void { try { this.db?.close(); } catch { /* ya cerrada */ } }

  private todas(sql: string, ...p: (string | number)[]): Fila[] {
    if (!this.db) return [];
    try { return this.db.prepare(sql).all(...p) as Fila[]; } catch { return []; }
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
}
