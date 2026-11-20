import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { entradaDeRegistro } from './observado';
import { ESQUEMA_FICHERO, VERSION_ANALISIS, type EntradaTarea, type FicheroAnalisis } from './tipos';

/**
 * Persistencia del análisis: un `analisis.json` junto al `tarea.json` de cada tarea en el registro de Atlas dev
 * (`<baúl>/registros/validadas/<id>_<slug>/`). Las tareas de la cola que aún no tienen carpeta en el registro usan
 * `<registros>/sin-registro/<id>/`. Nunca se toca `tarea.json` ni se copia el transcript (pesa MB y lleva datos de cuenta).
 * Escritura atómica (temporal + renombrado): un corte no deja un fichero a medias.
 */
export const FICHERO = 'analisis.json';
export const SIN_REGISTRO = 'sin-registro';

/** Misma resolución que el servidor de Atlas dev: ATLAS_REGISTRO_DIR, o el baúl (DOCS_ROOT / ATLAS_VAULT) + `registros`, o `<Workspace>/../atlas-vault`. */
export function dirRegistroPorDefecto(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env['ATLAS_REGISTRO_DIR']) return env['ATLAS_REGISTRO_DIR'];
  const baul = env['DOCS_ROOT'] ?? env['ATLAS_VAULT'];
  if (baul) return join(baul, 'registros');
  const ws = env['ATLAS_WORKSPACE'];
  return ws ? join(ws, '..', 'atlas-vault', 'registros') : null;
}

export interface TareaRegistrada { id: string; carpeta: string; entrada: EntradaTarea | null; error: string | null }

export class Repositorio {
  constructor(readonly dir: string) {}

  /** Tareas de `validadas/`. Una carpeta ilegible no detiene a las demás: sale con `error`. Si no hay registro, lanza (lo anota la rutina). */
  cargar(): TareaRegistrada[] {
    const raiz = join(this.dir, 'validadas');
    if (!existsSync(this.dir)) throw new Error(`no existe el registro de tareas: ${this.dir}`);
    if (!existsSync(raiz)) return [];
    return readdirSync(raiz, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
      const carpeta = join(raiz, d.name), id = d.name.split('_')[0]!;
      try {
        const entrada = entradaDeRegistro(JSON.parse(readFileSync(join(carpeta, 'tarea.json'), 'utf8')));
        return entrada ? { id: entrada.id, carpeta, entrada, error: null } : { id, carpeta, entrada: null, error: 'tarea.json sin tarea.id' };
      } catch (e) { return { id, carpeta, entrada: null, error: `tarea.json ilegible: ${(e as Error).message}` }; }
    });
  }

  /** Carpeta donde vive (o vivirá) el análisis de una tarea. */
  carpetaDe(id: string): string {
    const raiz = join(this.dir, 'validadas');
    if (existsSync(raiz)) { const d = readdirSync(raiz).find((n) => n === id || n.startsWith(`${id}_`)); if (d) return join(raiz, d); }
    return join(this.dir, SIN_REGISTRO, id);
  }

  leer(carpeta: string): FicheroAnalisis | null {
    try {
      const f = JSON.parse(readFileSync(join(carpeta, FICHERO), 'utf8')) as FicheroAnalisis;
      return f && typeof f === 'object' && f.proceso ? f : null;
    } catch { return null; }
  }

  escribir(carpeta: string, f: FicheroAnalisis): void {
    mkdirSync(carpeta, { recursive: true });
    const destino = join(carpeta, FICHERO);
    writeFileSync(`${destino}.tmp`, `${JSON.stringify(f, null, 2)}\n`, 'utf8');
    renameSync(`${destino}.tmp`, destino);
  }

  /** Todos los análisis guardados (de `validadas/` y `sin-registro/`). */
  todos(): FicheroAnalisis[] {
    const carpetas = ['validadas', SIN_REGISTRO].flatMap((s) => { const r = join(this.dir, s); return existsSync(r) ? readdirSync(r, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(r, d.name)) : []; });
    return carpetas.map((c) => this.leer(c)).filter((f): f is FicheroAnalisis => f !== null);
  }
}

export const ficheroNuevo = (id: string): FicheroAnalisis => ({ esquema: ESQUEMA_FICHERO, tarea_id: id, proceso: { estado: 'pendiente', intentos: 0, error: null, ultimo_intento: null, version_objetivo: VERSION_ANALISIS }, actual: null, historial: [] });

/** Bitácora de la rutina (JSONL): cada fallo de cola, registro o modelo queda aquí con su tarea, para poder reintentar. */
export interface EventoBitacora { ts: string; nivel: 'info' | 'aviso' | 'error'; evento: string; tarea?: string; detalle?: string }
export type Bitacora = (e: EventoBitacora) => void;
export function bitacoraEnFichero(ruta: string): Bitacora {
  return (e) => { try { mkdirSync(dirname(ruta), { recursive: true }); appendFileSync(ruta, `${JSON.stringify(e)}\n`, 'utf8'); } catch { /* sin disco no se rompe la rutina */ } };
}
