import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Límites del plan de los agentes (port de `app/limites_plan.py`). Atlas dev los lee de las CLIs y los deja en
 * `ATLAS_LIMITES_PLAN` (o `~/.atlas-dev/limites-plan.json`); aquí solo se leen. Si Claude pasa del umbral semanal
 * (`KARAJAN_LIMITE_CLAUDE`, 50 % por defecto) lo suyo va a Codex. Un dato de más de dos horas no se usa.
 *
 * Cada agente trae lo mismo: % semanal y de la ventana de 5 h, el instante de reinicio de cada una (`reinicio` la semanal,
 * `reinicioSesion` la de 5 h, si el fichero la trae), el plan y la fuente. El dosificador (`dosificador.ts`) los usa para repartir la
 * cuota; la decisión de arriba solo mira el % semanal de Claude.
 */
const MAX_EDAD_MS = 2 * 3600_000;

export interface UsoPlan { semanal?: number | null; sesion?: number | null; reinicio?: string | null; reinicioSesion?: string | null; plan?: string | null; fuente?: string | null }
export interface Limites { claude?: UsoPlan; codex?: UsoPlan; leido: string }

export const rutaLimites = () => process.env['KARAJAN_LIMITES_PLAN'] ?? process.env['ATLAS_LIMITES_PLAN'] ?? join(process.env['ATLAS_DEV_DATA'] ?? join(homedir(), '.atlas-dev'), 'limites-plan.json');
export const umbralClaude = () => { const n = Number(process.env['KARAJAN_LIMITE_CLAUDE'] ?? '50'); return Number.isFinite(n) ? n : 50; };

export function leerLimites(ahora = Date.now(), ruta = rutaLimites()): Limites | null {
  try {
    const d = JSON.parse(readFileSync(ruta, 'utf8')) as Limites;
    const t = Date.parse(d.leido);
    return Number.isFinite(t) && ahora - t <= MAX_EDAD_MS ? d : null;
  } catch { return null; }
}

/** Lo que dice el fichero aunque esté caducado (el dosificador decide qué hace con un dato viejo); null si no existe o no se lee. */
export function leerLimitesSinCaducidad(ruta = rutaLimites()): Limites | null {
  try {
    const d = JSON.parse(readFileSync(ruta, 'utf8')) as Limites;
    return d && typeof d === 'object' && typeof d.leido === 'string' ? d : null;
  } catch { return null; }
}

/** El % semanal de Claude si supera el umbral; `null` si no lo supera o no hay dato reciente. */
export function claudeExcedido(l: Limites | null = leerLimites()): number | null {
  const pct = Number(l?.claude?.semanal);
  return l?.claude?.semanal !== undefined && l?.claude?.semanal !== null && Number.isFinite(pct) && pct > umbralClaude() ? pct : null;
}
