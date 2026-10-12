import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { ID_PRESET_DOMINIO, presetDominio, type Perfil, type Regla } from './reglas';

/**
 * Perfiles de enrutado (`routing_layout.json`, el mismo fichero y esquema que `app/routing_layout.py`). Se comparte con el
 * Karajan nativo: lo que se configure desde Atlas dev lo ve también su vista Decisión, y al revés. Escritura atómica con
 * `.bak` del anterior; un fichero roto o vacío no tumba nada (se lee el `.bak` o un layout vacío), como en Python.
 *
 * La ejecución usa el perfil POR DEFECTO (`default_profile_id`), no el activo (el que se está editando): igual que el nativo.
 */
export interface Layout {
  entities: unknown[]; groups: unknown[]; zoom: number; drawer_width: number; openclaw_pos: { x: number; y: number }; rules: Regla[];
  active_profile_id: string; default_profile_id: string; profiles: Perfil[]; updated_at: string;
}

const CAMPOS_LIENZO = ['entities', 'groups', 'zoom', 'drawer_width', 'openclaw_pos', 'rules'] as const;
const ID_PERFIL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NIVELES = new Set(['level_1_simple', 'level_2_moderate', 'level_3_intermediate', 'level_4_complex', 'level_5_critical', 'N1', 'N2', 'N3', 'N4', 'N5']);

export class ErrorPerfil extends Error { status = 422; }
const falla = (m: string): never => { throw new ErrorPerfil(m); };

const copia = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const lienzoVacio = () => ({ entities: [], groups: [], zoom: 1, drawer_width: 320, openclaw_pos: { x: 0, y: 0 }, rules: [] as Regla[] });

function validarRegla(r: unknown, donde: string): Regla {
  const x = r as Regla;
  if (!x || typeof x !== 'object') falla(`${donde}: regla no válida`);
  if (typeof x.id !== 'string' || !x.id.trim() || x.id.length > 80) falla(`${donde}: la regla necesita un id`);
  if (typeof x.entity_id !== 'string' || !x.entity_id) falla(`${donde}: la regla «${x.id}» necesita una entidad`);
  for (const k of ['domains', 'intents'] as const) if (x[k] !== undefined && (!Array.isArray(x[k]) || x[k]!.some((v) => typeof v !== 'string'))) falla(`${donde}: «${k}» debe ser una lista de textos`);
  for (const k of ['level_min', 'level_max'] as const) if (x[k] !== undefined && x[k] !== null && (!Number.isInteger(x[k]) || x[k]! < 1 || x[k]! > 5)) falla(`${donde}: «${k}» debe estar entre 1 y 5`);
  return { id: x.id.trim(), name: typeof x.name === 'string' ? x.name : '', entity_id: x.entity_id, domains: x.domains ?? [], intents: x.intents ?? [], level_min: x.level_min ?? null, level_max: x.level_max ?? null, enabled: x.enabled !== false };
}

function validarPerfil(p: unknown): Perfil {
  const x = p as Perfil;
  if (!x || typeof x !== 'object') falla('perfil no válido');
  if (typeof x.id !== 'string' || !ID_PERFIL.test(x.id.trim()) || x.id.length > 80) falla(`id de perfil no válido: ${String(x.id)}`);
  if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > 100) falla(`el perfil «${x.id}» necesita un nombre`);
  if (!Array.isArray(x.entities)) falla(`el perfil «${x.id}» necesita una lista de entidades`);
  for (const e of x.entities) {
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !e.id || typeof e.role !== 'string') falla(`perfil «${x.id}»: entidad sin id o sin rol`);
    if (e.levels !== undefined && (!Array.isArray(e.levels) || e.levels.some((l) => !NIVELES.has(l)))) falla(`perfil «${x.id}»: niveles no válidos en «${e.id}»`);
    if (e.max_concurrent !== undefined && (!Number.isInteger(e.max_concurrent) || e.max_concurrent < 1)) falla(`perfil «${x.id}»: concurrencia no válida en «${e.id}»`);
  }
  const salida: Perfil = { ...x, id: x.id.trim(), name: x.name.trim() };
  if (x.rules !== undefined) {
    if (!Array.isArray(x.rules)) falla(`perfil «${x.id}»: «rules» debe ser una lista`);
    salida.rules = x.rules.map((r, i) => validarRegla(r, `perfil «${x.id}», regla ${i + 1}`));
  }
  return salida;
}

/** Valida (como el modelo Pydantic `RoutingLayout`) y migra un layout antiguo sin perfiles. */
export function validarLayout(bruto: unknown): Layout {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) falla('layout no válido');
  const d = { ...(bruto as Record<string, unknown>) };
  if (!Array.isArray(d['profiles'])) {
    d['profiles'] = [{ id: 'current', name: 'Esquema actual', ...Object.fromEntries(CAMPOS_LIENZO.filter((k) => k in d).map((k) => [k, d[k]])) }];
  }
  const perfiles = (d['profiles'] as unknown[]).map(validarPerfil);
  if (!perfiles.length) falla('el layout necesita al menos un perfil');
  const ids = perfiles.map((p) => p.id);
  if (new Set(ids).size !== ids.length) falla('los ids de perfil deben ser únicos');
  const activo = typeof d['active_profile_id'] === 'string' && d['active_profile_id'] ? d['active_profile_id'] : 'current';
  const defecto = typeof d['default_profile_id'] === 'string' && d['default_profile_id'] ? d['default_profile_id'] : activo;
  if (!ids.includes(activo)) falla(`el perfil activo «${activo}» no existe`);
  if (!ids.includes(defecto)) falla(`el perfil por defecto «${defecto}» no existe`);
  return {
    ...lienzoVacio(), ...Object.fromEntries(CAMPOS_LIENZO.filter((k) => k in d).map((k) => [k, d[k]])),
    active_profile_id: activo, default_profile_id: defecto, profiles: perfiles,
    updated_at: typeof d['updated_at'] === 'string' ? d['updated_at'] : new Date().toISOString(),
  } as Layout;
}

/** Copia en los campos de arriba el lienzo del perfil indicado (lo que hace `project_*_profile` en Python). */
export function proyectar(l: Layout, id = l.active_profile_id): Layout {
  const p = l.profiles.find((x) => x.id === id)!;
  const base = lienzoVacio();
  return { ...l, ...Object.fromEntries(CAMPOS_LIENZO.map((k) => [k, copia((p as Record<string, unknown>)[k] ?? base[k])])) } as Layout;
}

export const perfilPorDefecto = (l: Layout): Perfil => l.profiles.find((p) => p.id === l.default_profile_id)!;

export class Perfiles {
  constructor(private readonly ruta: string) {}

  private get bak() { return `${this.ruta}.bak`; }

  private leerFichero(ruta: string): Layout | null {
    try {
      if (!existsSync(ruta)) return null;
      const t = readFileSync(ruta, 'utf8');
      if (!t.trim() || t.includes('\u0000')) return null;
      return validarLayout(JSON.parse(t));
    } catch { return null; }
  }

  /** El layout guardado, proyectado sobre el perfil activo (para editar). */
  leer(): Layout {
    const l = this.leerFichero(this.ruta) ?? this.leerFichero(this.bak) ?? validarLayout({ profiles: [{ id: 'current', name: 'Esquema actual', entities: [] }] });
    return proyectar(l);
  }

  /**
   * Guarda el documento completo (como `PUT /routing-layout`). Los perfiles que llegan sin `rules` conservan las guardadas
   * (el lienzo nativo no conoce las reglas); los campos de arriba, si vienen, se vuelcan en el perfil activo.
   */
  guardar(bruto: unknown): Layout {
    const nuevo = validarLayout(bruto);
    const previo = this.leerFichero(this.ruta) ?? this.leerFichero(this.bak);
    const crudo = (bruto as { profiles?: Record<string, unknown>[] }).profiles ?? [];
    nuevo.profiles = nuevo.profiles.map((p, i) => {
      if (crudo[i] && 'rules' in crudo[i]!) return p;
      const antes = previo?.profiles.find((x) => x.id === p.id);
      return antes?.rules ? { ...p, rules: copia(antes.rules) } : p;
    });
    const arriba = bruto as Record<string, unknown>;
    const cambiados = CAMPOS_LIENZO.filter((k) => k in arriba);
    if (cambiados.length) {
      nuevo.profiles = nuevo.profiles.map((p) => (p.id === nuevo.active_profile_id ? { ...p, ...Object.fromEntries(cambiados.map((k) => [k, copia(arriba[k])])) } as Perfil : p));
    }
    nuevo.updated_at = new Date().toISOString();
    const final = proyectar(validarLayout(nuevo));
    mkdirSync(dirname(this.ruta), { recursive: true });
    const tmp = `${this.ruta}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(final, null, 2)}\n`, 'utf8');
    if (existsSync(this.ruta)) { try { copyFileSync(this.ruta, this.bak); } catch { /* sin copia: se sigue */ } }
    renameSync(tmp, this.ruta);
    return final;
  }

  /** Añade (o rehace) el perfil predefinido por dominio y lo deja activo y, si se pide, por defecto (el que ejecuta). */
  aplicarPresetDominio({ porDefecto = true }: { porDefecto?: boolean } = {}): Layout {
    const l = this.leer();
    const preset = presetDominio();
    const perfiles = [...l.profiles.filter((p) => p.id !== ID_PRESET_DOMINIO), preset];
    return this.guardar({ profiles: perfiles, active_profile_id: preset.id, default_profile_id: porDefecto ? preset.id : l.default_profile_id });
  }
}
