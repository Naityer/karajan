import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Límites del plan de los agentes (port de `app/limites_plan.py`). Atlas dev los lee de las CLIs y los deja en
 * `ATLAS_LIMITES_PLAN` (o `~/.atlas-dev/limites-plan.json`); aquí solo se leen. Si Claude pasa del umbral semanal
 * (`KARAJAN_LIMITE_CLAUDE`, 50 % por defecto) lo suyo va a Codex. Un dato de más de dos horas no se usa.
 */
const MAX_EDAD_MS = 2 * 3600_000;

export interface Limites { claude?: { semanal?: number | null; sesion?: number | null; reinicio?: string | null }; codex?: { semanal?: number | null; sesion?: number | null }; leido: string }

export const rutaLimites = () => process.env['KARAJAN_LIMITES_PLAN'] ?? process.env['ATLAS_LIMITES_PLAN'] ?? join(process.env['ATLAS_DEV_DATA'] ?? join(homedir(), '.atlas-dev'), 'limites-plan.json');
export const umbralClaude = () => { const n = Number(process.env['KARAJAN_LIMITE_CLAUDE'] ?? '50'); return Number.isFinite(n) ? n : 50; };

export function leerLimites(ahora = Date.now(), ruta = rutaLimites()): Limites | null {
  try {
    const d = JSON.parse(readFileSync(ruta, 'utf8')) as Limites;
    const t = Date.parse(d.leido);
    return Number.isFinite(t) && ahora - t <= MAX_EDAD_MS ? d : null;
  } catch { return null; }
}

/** El % semanal de Claude si supera el umbral; `null` si no lo supera o no hay dato reciente. */
export function claudeExcedido(l: Limites | null = leerLimites()): number | null {
  const pct = Number(l?.claude?.semanal);
  return l?.claude?.semanal !== undefined && l?.claude?.semanal !== null && Number.isFinite(pct) && pct > umbralClaude() ? pct : null;
}
