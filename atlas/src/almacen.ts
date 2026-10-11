import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { redondear } from './redondeo';
import type { RegistroTarea, Run } from './analitica';

/**
 * Registro de tareas de Karajan (`task_logs.db`, el mismo esquema que `app/database.py`): lectura de tareas, runs y decisiones
 * y las agregaciones de `/metrics` y `/agents/performance`. Solo lectura: quien escribe tareas (clasificar y delegar con
 * persistencia) es el Karajan completo; aquí se crean las tablas vacías si no existen para que un paquete recién instalado
 * responda, y se puede importar un `task_logs.db` existente (ver servidor.ts). Las filas dañadas se saltan, como en Python.
 */
export interface Tarea extends RegistroTarea { prompt: string; status: string; created_at: string; updated_at: string }

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, classification_json TEXT NOT NULL, delegation_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, level TEXT, model TEXT, score REAL, requires_review INTEGER, subtask_count INTEGER, est_cost REAL, schema_version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, phase TEXT NOT NULL, decision TEXT NOT NULL, score REAL, backend TEXT, reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_index INTEGER NOT NULL, provider_name TEXT, routing_entity_id TEXT, routing_entity_name_snapshot TEXT,
  model_id TEXT, backend TEXT, status TEXT NOT NULL, started_at TEXT, completed_at TEXT, latency_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL, error TEXT);
CREATE INDEX IF NOT EXISTS idx_decisions_task ON decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_runs_provider ON runs(provider_name);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);`;

type Fila = Record<string, unknown>;
const ESTADOS = new Set(['classified', 'delegated', 'queued', 'completed', 'failed', 'cancel_requested', 'outcome_unknown']);
const BACKENDS = new Set(['api', 'cli']);

export class Almacen {
  private readonly db: DatabaseSync;

  constructor(ruta: string) {
    mkdirSync(dirname(ruta), { recursive: true });
    this.db = new DatabaseSync(ruta);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(ESQUEMA);
  }

  cerrar(): void { try { this.db.close(); } catch { /* ya cerrada */ } }

  private todas(sql: string, ...params: (string | number)[]): Fila[] {
    try { return this.db.prepare(sql).all(...params) as Fila[]; } catch { return []; }
  }

  private agrupar(columna: 'level' | 'model' | 'status'): Record<string, number> {
    return Object.fromEntries(this.todas(`SELECT ${columna} AS k, COUNT(*) AS c FROM tasks WHERE ${columna} IS NOT NULL GROUP BY ${columna}`).map((f) => [String(f['k']), Number(f['c'])]));
  }

  contar(): number { return Number(this.todas('SELECT COUNT(*) AS c FROM tasks')[0]?.['c'] ?? 0); }

  metricas() {
    const agg = this.todas(`SELECT COUNT(*) AS total, COALESCE(SUM(subtask_count),0) AS subtasks, COALESCE(SUM(requires_review),0) AS reviews, COALESCE(SUM(est_cost),0.0) AS cost,
      COALESCE(AVG(score),0.0) AS avg_score, COALESCE(SUM(CASE WHEN delegation_json IS NOT NULL THEN 1 ELSE 0 END),0) AS delegated FROM tasks`)[0] ?? {};
    const porSkill: Record<string, number> = {};
    const porBackend: Record<string, number> = {};
    for (const f of this.todas('SELECT classification_json, delegation_json FROM tasks')) {
      try {
        const c = JSON.parse(String(f['classification_json'])) as RegistroTarea['classification'];
        for (const s of c.recommended_skills ?? []) porSkill[s] = (porSkill[s] ?? 0) + 1;
        for (const st of c.subtasks ?? []) if (st.recommended_skill) porSkill[st.recommended_skill] = (porSkill[st.recommended_skill] ?? 0) + 1;
        if (f['delegation_json']) for (const e of (JSON.parse(String(f['delegation_json'])) as { executions: { backend: string }[] }).executions) porBackend[e.backend] = (porBackend[e.backend] ?? 0) + 1;
      } catch { /* fila dañada: se salta */ }
    }
    const total = Number(agg['total'] ?? 0);
    return {
      total_tasks: total, by_level: this.agrupar('level'), by_model: this.agrupar('model'), by_backend: porBackend, by_status: this.agrupar('status'), by_skill: porSkill,
      total_subtasks: Number(agg['subtasks'] ?? 0), delegated_tasks: Number(agg['delegated'] ?? 0), human_review_required: Number(agg['reviews'] ?? 0),
      total_estimated_cost_usd: redondear(Number(agg['cost'] ?? 0), 5), average_complexity_score: total ? redondear(Number(agg['avg_score'] ?? 0), 2) : 0.0,
    };
  }

  rendimientoAgentes() {
    return this.todas(`SELECT provider_name, COUNT(*) AS task_count, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS error_count, AVG(latency_ms) AS avg_latency_ms,
      SUM(estimated_cost_usd) AS total_cost, SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) AS total_tokens FROM runs WHERE provider_name IS NOT NULL GROUP BY provider_name`)
      .map((f) => ({
        provider_name: String(f['provider_name']), task_count: Number(f['task_count']), error_count: Number(f['error_count'] ?? 0),
        avg_latency_ms: f['avg_latency_ms'] === null || f['avg_latency_ms'] === undefined ? null : Number(f['avg_latency_ms']),
        total_cost: redondear(Number(f['total_cost'] ?? 0), 5), total_tokens: Number(f['total_tokens'] ?? 0),
      }));
  }

  /**
   * Como `_row_to_record` de Python, que valida con Pydantic y se salta lo que no cumple: estado de tarea y de cada ejecución
   * desconocidos o un `backend` que no sea `api`/`cli` (las tareas antiguas con `simulated` se ignoran en listados y analítica,
   * aunque `/metrics`, que agrega en SQL, las siga contando).
   */
  private aTarea(f: Fila): Tarea | null {
    try {
      if (!ESTADOS.has(String(f['status']))) return null;
      const delegacion = f['delegation_json'] ? JSON.parse(String(f['delegation_json'])) as { executions?: { status?: string; backend?: string }[] } : null;
      for (const e of delegacion?.executions ?? []) if (!ESTADOS.has(String(e.status)) || !BACKENDS.has(String(e.backend))) return null;
      return {
        task_id: String(f['task_id']), prompt: String(f['prompt']), status: String(f['status']), created_at: String(f['created_at']), updated_at: String(f['updated_at']),
        classification: JSON.parse(String(f['classification_json'])), delegation: f['delegation_json'] ? JSON.parse(String(f['delegation_json'])) : null,
      };
    } catch { return null; }
  }

  listarTareas(limite?: number, desplazamiento = 0): Tarea[] {
    const filas = limite === undefined ? this.todas('SELECT * FROM tasks ORDER BY created_at DESC') : this.todas('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?', limite, desplazamiento);
    return filas.map((f) => this.aTarea(f)).filter((t): t is Tarea => t !== null);
  }

  tarea(id: string): Tarea | null {
    const f = this.todas('SELECT * FROM tasks WHERE task_id = ?', id)[0];
    return f ? this.aTarea(f) : null;
  }

  runs(id: string): Run[] { return this.todas('SELECT * FROM runs WHERE task_id = ? ORDER BY run_index', id); }

  decisiones(id?: string): Fila[] {
    return id === undefined ? this.todas('SELECT * FROM decisions ORDER BY created_at') : this.todas('SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at', id);
  }

  /** Búsqueda simple por texto (el original usa FTS5 con bm25 y recurre a LIKE; aquí siempre LIKE, sin depender de FTS). */
  buscar(texto: string, limite = 20): Fila[] {
    const q = texto.trim();
    if (!q) return [];
    const patron = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.todas("SELECT task_id, status, created_at, level, model, score, substr(prompt, 1, 160) AS title FROM tasks WHERE prompt LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?", patron, limite);
  }
}
