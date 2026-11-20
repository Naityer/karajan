import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { EntradaCadena, IdProveedor } from './proveedores';

/**
 * Configuración del análisis (`<datos>/analisis.json`). Todo es configurable; los valores por defecto priorizan lo local y sin coste:
 * Ollama primero, Gemini (`agy`) solo de respaldo y con tope, la destilación con un modelo mayor APAGADA hasta que se active.
 */
export interface ConfigDestilacion { activa: boolean; proveedor: IdProveedor; modelo: string | null; /** Mínimo de valores sin normalizar acumulados para que valga la pena proponer nada. */ minimoValores: number }
export interface ConfigAnalisis {
  /** Carpeta `registros/` del baúl; `null` = la resolución por defecto (ATLAS_REGISTRO_DIR, baúl, Workspace). */
  dirRegistro: string | null;
  cadena: EntradaCadena[];
  permitirGemini: boolean; maxGeminiPorEjecucion: number;
  timeoutMs: number; limitePorEjecucion: number; maxIntentos: number;
  /** Además del registro, mirar la cola de Atlas dev (tareas terminadas que aún no están en el registro). */
  usarCola: boolean;
  destilacion: ConfigDestilacion;
}

export const CONFIG_POR_DEFECTO: ConfigAnalisis = {
  dirRegistro: null,
  cadena: [{ id: 'ollama', modelo: 'qwen2.5:14b', activo: true }, { id: 'agy', modelo: null, activo: true }],
  permitirGemini: true, maxGeminiPorEjecucion: 5,
  timeoutMs: 180_000, limitePorEjecucion: 20, maxIntentos: 5, usarCola: true,
  destilacion: { activa: false, proveedor: 'claude-cli', modelo: 'opus', minimoValores: 10 },
};

const IDS: IdProveedor[] = ['ollama', 'agy', 'claude-cli', 'codex'];
const entero = (v: unknown, d: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : d);
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Valida lo leído: lo que no sea válido vuelve al valor por defecto (nunca rompe la rutina por una errata en el JSON). */
export function configDesde(raw: unknown): ConfigAnalisis {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>, d = CONFIG_POR_DEFECTO;
  const cadena = Array.isArray(r['cadena'])
    ? (r['cadena'] as unknown[]).flatMap((e): EntradaCadena[] => {
      const o = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
      return IDS.includes(o['id'] as IdProveedor) ? [{ id: o['id'] as IdProveedor, modelo: texto(o['modelo']), activo: o['activo'] !== false }] : [];
    })
    : d.cadena;
  const ds = (r['destilacion'] && typeof r['destilacion'] === 'object' ? r['destilacion'] : {}) as Record<string, unknown>;
  return {
    dirRegistro: texto(r['dirRegistro']), cadena: cadena.length ? cadena : d.cadena,
    permitirGemini: typeof r['permitirGemini'] === 'boolean' ? r['permitirGemini'] : d.permitirGemini,
    maxGeminiPorEjecucion: entero(r['maxGeminiPorEjecucion'], d.maxGeminiPorEjecucion, 0, 1000),
    timeoutMs: entero(r['timeoutMs'], d.timeoutMs, 5_000, 1_800_000), limitePorEjecucion: entero(r['limitePorEjecucion'], d.limitePorEjecucion, 1, 1000),
    maxIntentos: entero(r['maxIntentos'], d.maxIntentos, 1, 100), usarCola: typeof r['usarCola'] === 'boolean' ? r['usarCola'] : d.usarCola,
    destilacion: {
      activa: ds['activa'] === true, proveedor: IDS.includes(ds['proveedor'] as IdProveedor) ? (ds['proveedor'] as IdProveedor) : d.destilacion.proveedor,
      modelo: ds['modelo'] === null ? null : texto(ds['modelo']) ?? d.destilacion.modelo, minimoValores: entero(ds['minimoValores'], d.destilacion.minimoValores, 1, 10_000),
    },
  };
}

export function leerConfig(ruta: string): ConfigAnalisis {
  try { return configDesde(JSON.parse(readFileSync(ruta, 'utf8'))); } catch { return configDesde(null); }
}

export function guardarConfig(ruta: string, c: ConfigAnalisis): void {
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(`${ruta}.tmp`, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
  renameSync(`${ruta}.tmp`, ruta);
}

export const existeConfig = (ruta: string) => existsSync(ruta);
