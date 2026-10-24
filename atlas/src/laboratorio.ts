import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';

import type { TareaAtlas } from './atlas-dev';
import type { Hallazgo, Pasarela, Propuesto } from './pasarela-borradores';
import { motivoRetrabajo } from './produccion';

/**
 * Motor del laboratorio. Cada componente de Karajan trae su laboratorio: una lista de escenarios que miden SU función —
 * `contrato` (invariantes sobre su configuración), `replay` (sus decisiones frente a las de la persona en tareas reales de
 * Atlas dev, a ciegas) y `feedback` (frente a las correcciones humanas registradas). Un escenario devuelve métricas y hallazgos;
 * los `alta|media` salen como borradores por la pasarela, nunca como cambios.
 *
 * Nada de lo que corre aquí muta producción: los escenarios reciben el contexto en solo lectura. Las tareas de Atlas dev entran
 * ANONIMIZADAS: el prompt vive solo en memoria, el id se sustituye por un hash con sal local y no se guardan título, repo ni hoja.
 * Los resultados van a `laboratorio.db`, separada del `task_logs.db` que se comparte con el Karajan nativo.
 */
export type TipoEscenario = 'contrato' | 'replay' | 'feedback';
export interface Resultado {
  muestra: number;
  /** Con muestra insuficiente las métricas se dan pero no se sacan hallazgos de ellas. */
  suficiente: boolean;
  metricas: Record<string, number | null>;
  umbrales?: Record<string, string>;
  hallazgos: Hallazgo[];
  /** Tablas agregadas para el informe (sin prompts ni ids reales). */
  detalle?: unknown;
}
export interface Escenario<C = ContextoLab> { id: string; tipo: TipoEscenario; descripcion: string; ejecutar(ctx: C): Promise<Resultado> | Resultado }
export interface Laboratorio<C = ContextoLab> { escenarios: Escenario<C>[] }

/** Una tarea de Atlas dev tal como la ve el laboratorio. */
export interface TareaAnonima {
  hash: string;
  /** Solo en memoria: nunca se persiste ni sale en un informe. */
  prompt: string;
  /** El agente que eligió la persona en la hoja (`claude-cli`/`codex`), o null si lo eligió Karajan (`auto`). */
  agenteHumano: string | null;
  /** El que la ejecutó de verdad (también en las `auto`). */
  agenteReal: string | null;
  skillsHoja: string[];
  estado: string;
  /** Completada sin re-trabajo; null si aún no terminó. */
  exito: boolean | null;
  retrabajo: boolean;
  revisada: boolean;
  clasificacionHumana: Record<string, string[]>;
}
export interface Calibracion { tarea_hash: string; componente: string; propuesta: string[]; respuesta: 'si' | 'no' | 'sin_revisar'; correccion: string[]; creada: string }

export interface ContextoLab {
  tareas(): Promise<TareaAnonima[]>;
  calibraciones(componente: string): Calibracion[];
}

const AGENTES: Record<string, string> = { claude: 'claude-cli', 'claude-cli': 'claude-cli', codex: 'codex' };
const TERMINADAS = new Set(['completada', 'fallida']);

/** Sal local para los hashes (se crea una vez en `<datos>/laboratorio/sal`): el mismo id da el mismo hash en este equipo y en ninguno más. */
export function salLocal(dir: string): string {
  const ruta = join(dir, 'sal');
  if (existsSync(ruta)) return readFileSync(ruta, 'utf8').trim();
  mkdirSync(dir, { recursive: true });
  const sal = randomBytes(16).toString('hex');
  writeFileSync(ruta, sal, 'utf8');
  return sal;
}

export const hashTarea = (sal: string, id: string) => createHash('sha256').update(`${sal}:${id}`).digest('hex').slice(0, 16);

/** Las tareas de la cola, sin lo que identifica (id, título, repo, rama, hoja) y sin las propuestas del propio Karajan. */
export function anonimizar(tareas: TareaAtlas[], sal: string): TareaAnonima[] {
  const conPrompt = tareas.filter((t) => t.prompt && t.prompt.trim() && !/^Origen: karajan:/m.test(t.prompt)).sort((a, b) => a.creada - b.creada);
  return conPrompt.map((t, i) => {
    // Re-trabajo: una tarea posterior (24 h) vuelve sobre lo mismo; mismo criterio que la analítica de producción.
    const retrabajo = conPrompt.slice(i + 1).some((s) => s.creada - t.creada <= 86_400_000 && motivoRetrabajo(t.prompt!, s.prompt!) !== null);
    const elegido = t.hoja?.agente && t.hoja.agente !== 'auto' ? AGENTES[t.hoja.agente] ?? null : null;
    return {
      hash: hashTarea(sal, t.id), prompt: t.prompt!, agenteHumano: elegido, agenteReal: AGENTES[t.agente] ?? null,
      skillsHoja: elegido ? [...(t.hoja?.skills ?? [])] : [], estado: t.estado,
      exito: TERMINADAS.has(t.estado) ? t.estado === 'completada' && !retrabajo : null, retrabajo,
      revisada: t.hoja?.revisada === true, clasificacionHumana: t.hoja?.clasificacion ?? {},
    };
  });
}

/** Intervalo de Wilson (95 %) de una proporción k/n: [inferior, superior]. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n;
  const centro = (p + (z * z) / (2 * n)) / d, margen = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centro - margen), Math.min(1, centro + margen)];
}

export const proporcion = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 1000 : null);

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS lab_ejecuciones (id INTEGER PRIMARY KEY AUTOINCREMENT, componente TEXT NOT NULL, escenario TEXT NOT NULL, tipo TEXT NOT NULL, version TEXT NOT NULL,
  inicio TEXT NOT NULL, ms INTEGER NOT NULL, muestra INTEGER NOT NULL, suficiente INTEGER NOT NULL, metricas_json TEXT NOT NULL, hallazgos_json TEXT NOT NULL, detalle_json TEXT, error TEXT);
CREATE INDEX IF NOT EXISTS idx_lab_componente ON lab_ejecuciones(componente, inicio);
CREATE TABLE IF NOT EXISTS calibracion (id INTEGER PRIMARY KEY AUTOINCREMENT, tarea_hash TEXT NOT NULL, componente TEXT NOT NULL, propuesta_json TEXT NOT NULL,
  respuesta TEXT NOT NULL CHECK(respuesta IN ('si','no','sin_revisar')), correccion_json TEXT NOT NULL, creada TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_calibracion ON calibracion(componente, creada);`;

export interface Ejecucion { id: number; componente: string; escenario: string; tipo: string; version: string; inicio: string; ms: number; muestra: number; suficiente: boolean; metricas: Record<string, number | null>; hallazgos: Hallazgo[]; detalle: unknown; error: string | null;
  /** Umbrales con los que se juzgó el escenario (no existe en ejecuciones anteriores a que se guardaran). */ umbrales?: Record<string, string> | null }

export class RegistroLab {
  private readonly db: DatabaseSync;
  constructor(ruta: string) {
    mkdirSync(dirname(ruta), { recursive: true });
    this.db = new DatabaseSync(ruta);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(ESQUEMA);
    // Migración: los umbrales de cada ejecución se guardan desde que la ventana de arquitectura los muestra.
    const columnas = (this.db.prepare('PRAGMA table_info(lab_ejecuciones)').all() as { name: string }[]).map((c) => c.name);
    if (!columnas.includes('umbrales_json')) this.db.exec('ALTER TABLE lab_ejecuciones ADD COLUMN umbrales_json TEXT');
  }
  cerrar(): void { try { this.db.close(); } catch { /* ya cerrada */ } }

  guardar(e: Omit<Ejecucion, 'id'>): void {
    this.db.prepare(`INSERT INTO lab_ejecuciones (componente, escenario, tipo, version, inicio, ms, muestra, suficiente, metricas_json, hallazgos_json, detalle_json, error, umbrales_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.componente, e.escenario, e.tipo, e.version, e.inicio, e.ms, e.muestra, e.suficiente ? 1 : 0, JSON.stringify(e.metricas), JSON.stringify(e.hallazgos), e.detalle === undefined ? null : JSON.stringify(e.detalle), e.error, e.umbrales ? JSON.stringify(e.umbrales) : null);
  }

  ejecuciones(componente?: string, limite = 200): Ejecucion[] {
    const filas = (componente
      ? this.db.prepare('SELECT * FROM lab_ejecuciones WHERE componente = ? ORDER BY id DESC LIMIT ?').all(componente, limite)
      : this.db.prepare('SELECT * FROM lab_ejecuciones ORDER BY id DESC LIMIT ?').all(limite)) as Record<string, unknown>[];
    return filas.map((f) => ({
      id: Number(f['id']), componente: String(f['componente']), escenario: String(f['escenario']), tipo: String(f['tipo']), version: String(f['version']), inicio: String(f['inicio']),
      ms: Number(f['ms']), muestra: Number(f['muestra']), suficiente: f['suficiente'] === 1, metricas: JSON.parse(String(f['metricas_json'])) as Record<string, number | null>,
      hallazgos: JSON.parse(String(f['hallazgos_json'])) as Hallazgo[], detalle: f['detalle_json'] ? JSON.parse(String(f['detalle_json'])) : null, error: (f['error'] as string | null) ?? null,
      umbrales: f['umbrales_json'] ? JSON.parse(String(f['umbrales_json'])) as Record<string, string> : null,
    }));
  }

  guardarCalibracion(c: Calibracion): void {
    this.db.prepare('INSERT INTO calibracion (tarea_hash, componente, propuesta_json, respuesta, correccion_json, creada) VALUES (?,?,?,?,?,?)')
      .run(c.tarea_hash, c.componente, JSON.stringify(c.propuesta), c.respuesta, JSON.stringify(c.correccion), c.creada);
  }

  calibraciones(componente: string): Calibracion[] {
    return (this.db.prepare('SELECT * FROM calibracion WHERE componente = ? ORDER BY id').all(componente) as Record<string, unknown>[]).map((f) => ({
      tarea_hash: String(f['tarea_hash']), componente: String(f['componente']), propuesta: JSON.parse(String(f['propuesta_json'])) as string[],
      respuesta: f['respuesta'] as Calibracion['respuesta'], correccion: JSON.parse(String(f['correccion_json'])) as string[], creada: String(f['creada']),
    }));
  }
}

export interface InformeLab { componente: string; version: string; escenarios: (Omit<Ejecucion, 'id' | 'componente' | 'version'> & { propuestas: Propuesto[] })[] }

/** Ejecuta todos los escenarios de un laboratorio (o uno), guarda cada resultado y propone sus hallazgos por la pasarela. */
export async function ejecutarLaboratorio<C>(componente: { id: string; version: string; laboratorio: Laboratorio<C> }, ctx: C, registro: RegistroLab,
  op: { pasarela?: Pasarela | null; escenario?: string | null; ahora?: () => Date } = {}): Promise<InformeLab> {
  const informe: InformeLab = { componente: componente.id, version: componente.version, escenarios: [] };
  for (const esc of componente.laboratorio.escenarios.filter((e) => !op.escenario || e.id === op.escenario)) {
    const inicio = (op.ahora ?? (() => new Date()))();
    const t0 = performance.now();
    let r: Resultado = { muestra: 0, suficiente: false, metricas: {}, hallazgos: [] };
    let error: string | null = null;
    try { r = await esc.ejecutar(ctx); } catch (e) { error = String((e as Error).message ?? e).slice(0, 500); }
    const fila = {
      escenario: esc.id, tipo: esc.tipo, inicio: inicio.toISOString(), ms: Math.round(performance.now() - t0), muestra: r.muestra, suficiente: r.suficiente,
      metricas: r.metricas, hallazgos: r.hallazgos, detalle: r.detalle ?? null, error, umbrales: r.umbrales ?? null,
    };
    registro.guardar({ componente: componente.id, version: componente.version, ...fila });
    const propuestas: Propuesto[] = [];
    if (op.pasarela) for (const h of r.hallazgos) propuestas.push(await op.pasarela.proponer(componente.id, h));
    informe.escenarios.push({ ...fila, propuestas });
  }
  return informe;
}
