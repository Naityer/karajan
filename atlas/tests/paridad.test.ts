import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import { Almacen } from '../src/almacen';
import { construirAnaliticaSkills } from '../src/analitica';
import { clasificar, configDesde } from '../src/heuristica';
import { formatear, redondear } from '../src/redondeo';

/**
 * Paridad con el Karajan en Python: las fixtures las genera el propio Python (`classify_prompt`, `TaskStore`,
 * `build_skill_analytics`) y aquí se exige el mismo resultado, valor a valor. Ver ../PORTE.md para regenerarlas.
 */
const fixtures = (nombre: string) => join(import.meta.dirname, 'fixtures', nombre);
const leer = <T>(nombre: string) => JSON.parse(readFileSync(fixtures(nombre), 'utf8')) as T;
const sinVolatiles = <T extends object>(c: T) => { const { task_id: _t, created_at: _c, ...resto } = c as Record<string, unknown>; return resto; };

describe('redondeo como Python', () => {
  it('empates al par y valor exacto del binario', () => {
    assert.equal(redondear(0.125, 2), 0.12);
    assert.equal(redondear(2.675, 2), 2.67);
    assert.equal(redondear(1.005, 2), 1);
    assert.equal(redondear(0.5, 0), 0);
    assert.equal(redondear(1.5, 0), 2);
    assert.equal(redondear(-2.5, 0), -2);
    assert.equal(formatear(3.25, 1), '3.2');
    assert.equal(formatear(1.75, 1), '1.8');
    assert.equal(formatear(1.85, 1), '1.9');
    assert.equal(formatear(5, 1), '5.0');
  });
});

describe('clasificación heurística', () => {
  const casos = leer<{ prompt: string; con_config: Record<string, unknown>; sin_config: Record<string, unknown> }[]>('clasificacion.json');
  const config = configDesde(null);
  it('hay fixtures', () => assert.ok(casos.length >= 25));
  for (const [i, caso] of casos.entries()) {
    it(`#${i} con configuración: ${caso.prompt.slice(0, 50)}`, () => assert.deepStrictEqual(sinVolatiles(clasificar(caso.prompt, config)), caso.con_config));
    it(`#${i} sin configuración: ${caso.prompt.slice(0, 50)}`, () => assert.deepStrictEqual(sinVolatiles(clasificar(caso.prompt, null)), caso.sin_config));
  }
});

describe('registro de tareas y analítica', () => {
  const dir = mkdtempSync(join(tmpdir(), 'karajan-atlas-'));
  const copia = join(dir, 'tareas.db');
  copyFileSync(fixtures('tareas.db'), copia);
  const almacen = new Almacen(copia);
  const esperado = leer<{
    ahora: string; metricas: Record<string, unknown>; agentes: { provider_name: string }[]; skills_conocidas: string[]; analitica: Record<string, unknown>;
  }>('analitica.json');
  after(() => { almacen.cerrar(); rmSync(dir, { recursive: true, force: true }); });

  it('métricas', () => assert.deepStrictEqual(almacen.metricas(), esperado.metricas));
  it('rendimiento por agente', () => {
    const orden = <T extends { provider_name: string }>(l: T[]) => [...l].sort((a, b) => a.provider_name.localeCompare(b.provider_name));
    assert.deepStrictEqual(orden(almacen.rendimientoAgentes()), orden(esperado.agentes));
  });
  it('lee las tareas con su delegación', () => {
    const t = almacen.listarTareas();
    assert.equal(t.length, 16);
    assert.ok(t.some((x) => x.delegation) && t.some((x) => !x.delegation));
    assert.equal(almacen.tarea('tsk_fix000')?.task_id, 'tsk_fix000');
    assert.equal(almacen.tarea('no-existe'), null);
  });
  for (const dias of [0, 30, 3650]) {
    it(`analítica de skills a ${dias} días`, () => {
      const registros = almacen.listarTareas();
      const runsPorTarea = Object.fromEntries(registros.filter((r) => r.delegation).map((r) => [r.task_id, almacen.runs(r.task_id)]));
      const obtenido = construirAnaliticaSkills(registros, { runsPorTarea, skillsConocidas: esperado.skills_conocidas, dias, ahora: new Date(esperado.ahora) });
      assert.deepStrictEqual(obtenido, esperado.analitica[String(dias)]);
    });
  }
  it('la búsqueda no se rompe con comodines ni comillas', () => {
    assert.ok(Array.isArray(almacen.buscar("100% 'x' _ \\")));
    assert.deepStrictEqual(almacen.buscar('   '), []);
  });
});

describe('tolerancia a datos antiguos', () => {
  it('se salta las tareas con un backend desconocido, pero las métricas (SQL) las cuentan, como en Python', () => {
    const dir = mkdtempSync(join(tmpdir(), 'karajan-atlas-'));
    const copia = join(dir, 'tareas.db');
    copyFileSync(fixtures('tareas.db'), copia);
    const antes = new Almacen(copia);
    const n = antes.listarTareas().length;
    const origen = antes.listarTareas().find((t) => t.delegation)!;
    antes.cerrar();
    const db = new DatabaseSync(copia);
    const delegacion = JSON.parse(JSON.stringify(origen.delegation)) as { executions: { backend: string }[] };
    delegacion.executions[0]!.backend = 'simulated';
    db.prepare("INSERT INTO tasks (task_id, prompt, status, classification_json, delegation_json, created_at, updated_at, level, model, score, requires_review, subtask_count, est_cost) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run('tsk_antigua', 'x', 'completed', JSON.stringify(origen.classification), JSON.stringify(delegacion), '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', 'level_1_simple', 'cheap_model', 1, 0, 2, 0);
    db.close();
    const despues = new Almacen(copia);
    assert.equal(despues.listarTareas().length, n);
    assert.equal(despues.tarea('tsk_antigua'), null);
    assert.equal(despues.metricas().total_tasks, n + 1);
    assert.equal(despues.metricas().by_backend['simulated'], 1);
    despues.cerrar();
    rmSync(dir, { recursive: true, force: true });
  });
});
