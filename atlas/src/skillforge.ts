import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { agrupar, UMBRALES_TUTORIA, type ExamenAnonimo } from './tutoria-nota';

/**
 * Puente con la skill `skillforge-lab` (skills-package/skillforge-lab). La tutoría mide dónde falla el agente local; SkillForge
 * forja skills para ese alumno con el tutor como Teacher; aquí se leen las que quedaron activas y validadas con modelos reales
 * y se miden de nuevo, con y sin ellas, en tareas reales ya integradas.
 *
 * Nada de esto instala una skill: la forjada solo entra en el prompt del alumno dentro del sandbox de un examen. Y de Karajan
 * a SkillForge solo salen agregados anónimos (dominio, nivel, notas, obstáculos), nunca prompts, ids de tarea ni commits.
 */
export interface SkillForjada { id: string; version: number; dominios: string[]; instrucciones: string }
export interface AgenteRef { proveedor: string; modelo: string }

export interface Brecha { dominio: string; nivel: number; n: number; media: number; aprobacion: number | null; delegable: boolean; obstaculos: Record<string, number> }
export interface InformeBrechas { schema_version: 1; origen: 'karajan-tutoria'; generado: string; alumno: AgenteRef; tutor: AgenteRef; brechas: Brecha[] }

/** La skill y su versión tal y como queda anotada en un examen. */
export const etiquetaForjada = (s: Pick<SkillForjada, 'id' | 'version'>) => `${s.id}@v${s.version}`;
const MAX_INSTRUCCIONES = 16_000;

/** `proveedor:modelo` como lo escribe SkillForge en `models`; null si el proveedor no tiene equivalente. */
export function claveSkillForge(proveedor: string, modelo: string): string | null {
  const p = proveedor.startsWith('ollama') ? 'ollama' : proveedor === 'claude-cli' ? 'claude' : proveedor === 'codex' ? 'codex' : null;
  return p && modelo ? `${p}:${modelo}` : null;
}

/** Dónde está el laboratorio: `KARAJAN_SKILLFORGE_DIR` o, si existe, el del Workspace. Null si no está (la integración se apaga). */
export function carpetaSkillForge(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env['KARAJAN_SKILLFORGE_DIR'] || (env['ATLAS_WORKSPACE'] ? join(env['ATLAS_WORKSPACE'], 'skills-package', 'skillforge-lab') : '');
  return dir && existsSync(join(dir, 'skillforge', 'cli.py')) ? dir : null;
}

/** Lo que dice el CLI de SkillForge, sin fiarse: cualquier cosa que no encaje se descarta. */
export function interpretarSkills(salida: string): SkillForjada[] {
  let v: unknown;
  try { v = JSON.parse(salida); } catch { return []; }
  if (!Array.isArray(v)) return [];
  return v.flatMap((x): SkillForjada[] => {
    const o = x as Record<string, unknown> | null;
    if (!o || typeof o['id'] !== 'string' || !/^[\w-]+$/.test(o['id']) || !Number.isInteger(o['version']) || typeof o['instructions'] !== 'string') return [];
    const texto = (o['instructions'] as string).trim();
    const dominios = Array.isArray(o['domains']) ? (o['domains'] as unknown[]).filter((d): d is string => typeof d === 'string') : [];
    return texto && texto.length <= MAX_INSTRUCCIONES && dominios.length ? [{ id: o['id'], version: o['version'] as number, dominios, instrucciones: texto }] : [];
  });
}

type Lanzar = (cmd: string, args: string[], cwd: string) => { ok: boolean; salida: string };
const lanzarPython: Lanzar = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { ok: r.status === 0, salida: (r.stdout ?? '').toString() };
};

/** Skills activas y validadas de SkillForge compatibles con este alumno. Nunca lanza: sin laboratorio o con error, no hay ninguna. */
export function leerSkillsForjadas(dir: string | null, alumno: AgenteRef, lanzar: Lanzar = lanzarPython): SkillForjada[] {
  const clave = claveSkillForge(alumno.proveedor, alumno.modelo);
  if (!dir || !clave) return [];
  for (const py of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) {
    const r = lanzar(py, ['-m', 'skillforge', 'skills', 'active', '--model', clave], dir);
    if (r.ok) return interpretarSkills(r.salida);
  }
  return [];
}

/** Las skills forjadas que valen para un dominio (el dominio de la skill es el id de la tarea con la que se validó). */
export const aplicables = (forjadas: SkillForjada[], dominio: string): SkillForjada[] => forjadas.filter((s) => s.dominios.includes(dominio));

/** Un examen del alumno «desnudo»: sin skills forjadas. La nota del alumno solo se calcula con estos. */
export const esBase = (e: ExamenAnonimo) => !e.forjadas?.length;
export const claveConjunto = (etiquetas: string[]) => [...etiquetas].sort().join('+');

/** Dónde el alumno no es delegable, por dominio y nivel. Solo exámenes calificados y sin skills forjadas. */
export function brechas(examenes: ExamenAnonimo[]): Brecha[] {
  const base = examenes.filter((e) => esBase(e) && e.nota !== null);
  const claves = new Map<string, { dominio: string; nivel: number }>();
  for (const e of base) claves.set(`${e.dominio}·${e.nivel}`, { dominio: e.dominio, nivel: e.nivel });
  return [...claves.values()].sort((a, b) => a.dominio.localeCompare(b.dominio) || a.nivel - b.nivel).map(({ dominio, nivel }) => {
    const grupo = base.filter((e) => e.dominio === dominio && e.nivel === nivel);
    const s = agrupar(grupo, () => 'g')[0]!;
    const obstaculos: Record<string, number> = {};
    for (const e of grupo) for (const o of e.obstaculos) obstaculos[o] = (obstaculos[o] ?? 0) + 1;
    return { dominio, nivel, n: s.n, media: s.media, aprobacion: s.aprobacion, delegable: s.delegable, obstaculos };
  });
}

export function informeBrechas(examenes: ExamenAnonimo[], alumno: AgenteRef, tutor: AgenteRef, ahora = new Date()): InformeBrechas {
  return { schema_version: 1, origen: 'karajan-tutoria', generado: ahora.toISOString(), alumno, tutor, brechas: brechas(examenes) };
}

export interface EfectoForjada {
  /** Conjunto de skills forjadas que llevaba el alumno (`id@vN`, unidas con +). */
  skills: string; pares: number; deltaMedio: number; mejoran: number; empeoran: number;
  /** Mejora medida en tareas reales: muestra suficiente, ganancia mínima y pocos empeoramientos. */
  util: boolean;
}

/**
 * Efecto de las skills forjadas sobre la nota, emparejado por tarea: la misma tarea, el mismo alumno, con y sin skill.
 * Solo cuentan los pares con las dos notas. Sin pares suficientes no hay veredicto, no «cero».
 */
export function efectoForjadas(examenes: ExamenAnonimo[]): EfectoForjada[] {
  const U = UMBRALES_TUTORIA;
  const base = new Map<string, number>();
  for (const e of examenes) if (esBase(e) && e.nota !== null) base.set(`${e.alumno}|${e.tarea}`, e.nota);
  const grupos = new Map<string, number[]>();
  for (const e of examenes) {
    const b = e.forjadas?.length && e.nota !== null ? base.get(`${e.alumno}|${e.tarea}`) : undefined;
    if (b === undefined) continue;
    const k = claveConjunto(e.forjadas!);
    grupos.set(k, [...(grupos.get(k) ?? []), e.nota! - b]);
  }
  return [...grupos].map(([skills, d]) => {
    const media = Math.round((d.reduce((s, x) => s + x, 0) / d.length) * 10) / 10;
    const empeoran = d.filter((x) => x < 0).length;
    return { skills, pares: d.length, deltaMedio: media, mejoran: d.filter((x) => x > 0).length, empeoran, util: d.length >= U.muestraSegmento && media >= U.mejoraForjada && empeoran / d.length <= U.maxEmpeoranForjada };
  }).sort((a, b) => a.skills.localeCompare(b.skills));
}
