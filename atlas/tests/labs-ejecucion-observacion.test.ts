import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import { Almacen } from '../src/almacen';
import type { RegistroTarea } from '../src/analitica';
import { laboratorioAislamiento } from '../src/lab/aislamiento.lab';
import { laboratorioAlmacen } from '../src/lab/almacen.lab';
import { laboratorioAnalitica, type ContextoAnalitica } from '../src/lab/analitica.lab';
import { laboratorioLimites } from '../src/lab/limites.lab';
import { laboratorioProduccion } from '../src/lab/produccion.lab';
import { laboratorioProveedores, type ContextoProveedores } from '../src/lab/proveedores.lab';
import type { ContextoLab, TareaAnonima } from '../src/laboratorio';
import type { RunAnalitica } from '../src/produccion';

/** Datos sintéticos en temporales: ningún test lee el registro, los límites ni el Workspace reales del equipo. */
const dir = mkdtempSync(join(tmpdir(), 'karajan-labs-eo-'));
const abiertos: Almacen[] = [];
after(() => { for (const a of abiertos) a.cerrar(); rmSync(dir, { recursive: true, force: true }); });
let n = 0;
const nuevo = (nombre: string) => { const d = join(dir, `${nombre}-${++n}`); mkdirSync(d, { recursive: true }); return d; };
const base: ContextoLab = { tareas: async () => [], calibraciones: () => [] };
const esc = <C,>(lab: { escenarios: { id: string; ejecutar(c: C): unknown }[] }, id: string) => lab.escenarios.find((e) => e.id === id)!;
const hayGit = spawnSync('git', ['--version']).status === 0;

function almacenCon(f: (a: Almacen) => void): Almacen {
  const a = new Almacen(join(nuevo('registro'), 'task_logs.db'));
  abiertos.push(a);
  f(a);
  return a;
}
const clasificacion = (id: string) => ({ task_id: id, original_prompt: 'p', created_at: '2026-01-02T03:04:05+00:00', complexity_level: 'level_2_moderate', recommended_model: 'medium_model', complexity_score: 2, requires_human_review: false, subtasks: [] });

describe('laboratorio del almacén', () => {
  it('ida y vuelta: lo que se escribe es lo que se lee, y no deja temporales', async () => {
    const antes = new Set([...(await import('node:fs')).readdirSync(tmpdir())].filter((x) => x.startsWith('karajan-lab-almacen-')));
    const r = await esc(laboratorioAlmacen, 'ida-y-vuelta').ejecutar({ ...base, almacen: almacenCon(() => {}) });
    assert.deepEqual((r as { detalle: { fallos: string[] } }).detalle.fallos, []);
    assert.equal((r as { hallazgos: unknown[] }).hallazgos.length, 0);
    const despues = [...(await import('node:fs')).readdirSync(tmpdir())].filter((x) => x.startsWith('karajan-lab-almacen-') && !antes.has(x));
    assert.deepEqual(despues, []);
  });

  it('integridad: un registro limpio no da hallazgos; huérfanos y estados raros, sí (alta)', async () => {
    const limpio = almacenCon((a) => {
      a.guardarTarea(clasificacion('t1'), 'classified');
      a.registrarDecision({ task_id: 't1', phase: 'assign', decision: 'x' });
      a.registrarRun({ task_id: 't1', provider_name: 'codex', routing_entity_id: null, routing_entity_name_snapshot: null, model_id: 'm', backend: 'cli', status: 'completed', started_at: '2026-01-02T03:04:10+00:00', completed_at: '2026-01-02T03:04:20+00:00', latency_ms: 10, input_tokens: 1, output_tokens: 1, estimated_cost_usd: 0, error: null });
    });
    const ok = await esc(laboratorioAlmacen, 'integridad').ejecutar({ ...base, almacen: limpio }) as { hallazgos: unknown[]; suficiente: boolean };
    assert.equal(ok.hallazgos.length, 0);
    assert.equal(ok.suficiente, true);

    const ruta = join(nuevo('sucio'), 'task_logs.db');
    const sucio = new Almacen(ruta);
    abiertos.push(sucio);
    sucio.guardarTarea(clasificacion('t1'), 'classified');
    const db = new DatabaseSync(ruta);
    db.prepare("INSERT INTO decisions VALUES ('d1','fantasma','assign','x',NULL,NULL,'','2026-01-01T00:00:00+00:00')").run();
    db.prepare("INSERT INTO runs (id,task_id,run_index,status,started_at,completed_at) VALUES ('r1','fantasma',0,'raro','2026-01-02T00:00:10+00:00','2026-01-02T00:00:00+00:00')").run();
    db.close();
    const r = await esc(laboratorioAlmacen, 'integridad').ejecutar({ ...base, almacen: sucio }) as { hallazgos: { clave: string; severidad: string; evidencia: string }[]; metricas: Record<string, number> };
    assert.deepEqual([r.metricas['decisiones_huerfanas'], r.metricas['runs_huerfanos'], r.metricas['runs_estado_invalido'], r.metricas['runs_fecha_incoherente']], [1, 1, 1, 1]);
    const h = r.hallazgos.find((x) => x.clave === 'registro-incoherente')!;
    assert.equal(h.severidad, 'alta');
    assert.match(h.evidencia, /decisiones de tareas que no existen/);
  });
});

describe('laboratorio de los proveedores', () => {
  const runs = (p: string, ok: number, mal: number, error = 'Error: sesión caducada tras 30 s'): RunAnalitica[] => [
    ...Array.from({ length: ok }, () => ({ provider_name: p, status: 'completed', error: null })),
    ...Array.from({ length: mal }, (_, i) => ({ provider_name: p, status: 'failed', error: error.replace('30', String(30 + i)) })),
  ];
  const ctx = (r: RunAnalitica[], encontrados = true): ContextoProveedores => ({ ...base, runs: () => r, buscar: (b) => (encontrados ? `/bin/${b}` : null) });

  it('contrato: la tabla está completa; un binario ausente es un aviso bajo, no un fallo', () => {
    const bien = esc(laboratorioProveedores, 'contrato').ejecutar(ctx([])) as { hallazgos: unknown[]; metricas: Record<string, number> };
    assert.equal(bien.hallazgos.length, 0);
    assert.equal(bien.metricas['binarios_encontrados'], bien.metricas['proveedores']);
    const sin = esc(laboratorioProveedores, 'contrato').ejecutar(ctx([], false)) as { hallazgos: { clave: string; severidad: string }[] };
    assert.deepEqual(sin.hallazgos.map((h) => [h.clave, h.severidad]), [['binario-ausente', 'baja']]);
  });

  it('fallos: detecta al proveedor que falla significativamente más y agrupa los motivos', () => {
    const r = esc(laboratorioProveedores, 'fallos').ejecutar(ctx([...runs('codex', 20, 0), ...runs('claude-cli', 3, 12), ...runs('ollama-qwen', 3, 0)])) as {
      suficiente: boolean; hallazgos: { clave: string; severidad: string; evidencia: string }[]; detalle: { proveedores: Record<string, { fallos: number; motivos: { motivo: string; veces: number }[] }> } };
    assert.equal(r.suficiente, true);
    assert.deepEqual(r.hallazgos.map((h) => [h.clave, h.severidad]), [['falla-mas:claude-cli', 'media']]);
    // Los 12 fallos distintos solo en el número se agrupan en un motivo.
    assert.deepEqual(r.detalle.proveedores['claude-cli']!.motivos, [{ motivo: 'Error: sesión caducada tras # s', veces: 12 }]);
  });

  it('fallos: con una tasa parecida, o con muestra corta, no concluye nada', () => {
    const parecidas = esc(laboratorioProveedores, 'fallos').ejecutar(ctx([...runs('codex', 15, 5), ...runs('claude-cli', 14, 6)])) as { hallazgos: unknown[] };
    assert.equal(parecidas.hallazgos.length, 0);
    const corta = esc(laboratorioProveedores, 'fallos').ejecutar(ctx([...runs('codex', 5, 0), ...runs('claude-cli', 0, 4)])) as { suficiente: boolean; hallazgos: unknown[]; metricas: Record<string, number> };
    assert.equal(corta.suficiente, false);
    assert.equal(corta.hallazgos.length, 0);
    assert.equal(corta.metricas['fallos'], 4);
  });
});

describe('laboratorio de los límites', () => {
  const HORA = 3_600_000;
  const AHORA = Date.parse('2026-06-01T12:00:00Z');
  function conUmbral<T>(umbral: string, f: () => T): T {
    const previo = process.env['KARAJAN_LIMITE_CLAUDE'];
    process.env['KARAJAN_LIMITE_CLAUDE'] = umbral;
    try { return f(); } finally { if (previo === undefined) delete process.env['KARAJAN_LIMITE_CLAUDE']; else process.env['KARAJAN_LIMITE_CLAUDE'] = previo; }
  }
  const fichero = (semanal: number | null, hace: number) => {
    const ruta = join(nuevo('limites'), 'limites-plan.json');
    writeFileSync(ruta, JSON.stringify({ claude: { semanal }, leido: new Date(AHORA - hace).toISOString() }), 'utf8');
    return ruta;
  };
  const ejecutar = (id: string, ruta: string, umbral = '50') => conUmbral(umbral, () => esc(laboratorioLimites, id).ejecutar({ ...base, ruta, ahora: () => AHORA })) as { suficiente: boolean; hallazgos: { clave: string; severidad: string }[]; metricas: Record<string, number | null> };

  it('un fichero fresco con el umbral en rango no da hallazgos, y la decisión coincide (también con Claude excedido)', () => {
    for (const semanal of [20, 80]) {
      const ruta = fichero(semanal, HORA / 2);
      assert.deepEqual(ejecutar('fichero', ruta).hallazgos, []);
      const d = ejecutar('decision', ruta);
      assert.deepEqual(d.hallazgos, []);
      assert.equal(d.metricas['excedido'], semanal > 50 ? 1 : 0);
      assert.equal(d.metricas['coincide_con_fichero'], 1);
    }
  });

  it('avisa si falta, está caducado o el umbral no es un porcentaje', () => {
    assert.deepEqual(ejecutar('fichero', join(dir, 'no-existe.json')).hallazgos.map((h) => [h.clave, h.severidad]), [['sin-fichero', 'baja']]);
    assert.deepEqual(ejecutar('fichero', fichero(90, 3 * HORA)).hallazgos.map((h) => [h.clave, h.severidad]), [['fichero-caducado', 'media']]);
    assert.deepEqual(ejecutar('fichero', fichero(10, 0), '150').hallazgos.map((h) => [h.clave, h.severidad]), [['umbral-fuera-de-rango', 'alta']]);
    assert.equal(ejecutar('fichero', fichero(10, 0), '150').metricas['umbral_en_rango'], 0);
  });

  it('no escribe el fichero que lee', () => {
    const ruta = fichero(60, 0);
    const antes = (spawnSync(process.execPath, ['-e', `process.stdout.write(String(require('fs').statSync(${JSON.stringify(ruta)}).mtimeMs))`]).stdout ?? '').toString();
    ejecutar('fichero', ruta); ejecutar('decision', ruta);
    const despues = (spawnSync(process.execPath, ['-e', `process.stdout.write(String(require('fs').statSync(${JSON.stringify(ruta)}).mtimeMs))`]).stdout ?? '').toString();
    assert.equal(despues, antes);
  });
});

describe('laboratorio del aislamiento', () => {
  const git = (cwd: string, ...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const repoCon = (nombre: string) => {
    const repo = join(nuevo(nombre), 'repo');
    mkdirSync(repo, { recursive: true });
    for (const a of [['init', '-q'], ['config', 'user.name', 't'], ['config', 'user.email', 't@t'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
    writeFileSync(join(repo, 'a.txt'), 'a\n', 'utf8');
    git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'base');
    return repo;
  };

  it('ciclo: worktree, rama, commit con trailers, cierre y limpieza sin mover main', { skip: !hayGit }, () => {
    const r = esc(laboratorioAislamiento, 'ciclo').ejecutar({ ...base, workspace: null }) as { detalle: { fallos: string[] }; hallazgos: unknown[]; metricas: Record<string, number> };
    assert.deepEqual(r.detalle.fallos, []);
    assert.equal(r.hallazgos.length, 0);
  });

  it('huérfanos: cuenta, en solo lectura, worktrees sin carpeta y ramas integradas', { skip: !hayGit }, () => {
    const ws = nuevo('workspace');
    const repo = join(ws, 'proyecto');
    const origen = repoCon('origen');
    spawnSync('git', ['clone', '-q', origen, repo]);
    for (const a of [['config', 'user.name', 't'], ['config', 'user.email', 't@t'], ['config', 'commit.gpgsign', 'false']]) git(repo, ...a);
    const principal = git(repo, 'branch', '--show-current').stdout.trim();
    git(repo, 'branch', 'agente/integrada');
    const viva = join(nuevo('fuera'), 'viva'), muerta = join(nuevo('fuera'), 'muerta');
    git(repo, 'worktree', 'add', '-q', '-b', 'agente/viva', viva);
    git(repo, 'worktree', 'add', '-q', '-b', 'agente/muerta', muerta);
    rmSync(muerta, { recursive: true, force: true });
    const antes = git(repo, 'worktree', 'list', '--porcelain').stdout;
    const r = esc(laboratorioAislamiento, 'huerfanos').ejecutar({ ...base, workspace: ws }) as { suficiente: boolean; hallazgos: { clave: string; severidad: string }[]; metricas: Record<string, number> };
    assert.equal(r.suficiente, true);
    assert.equal(r.metricas['repos'], 1);
    assert.equal(r.metricas['worktrees_sin_carpeta'], 1);
    assert.equal(r.metricas['worktrees_vivos'], 1);
    assert.ok(r.metricas['ramas_integradas']! >= 1, principal);
    assert.deepEqual(r.hallazgos.map((h) => h.severidad), ['baja', 'baja']);
    // Solo lectura: nada podado ni borrado.
    assert.equal(git(repo, 'worktree', 'list', '--porcelain').stdout, antes);
    assert.ok(git(repo, 'rev-parse', '--verify', 'agente/muerta').status === 0 && existsSync(viva));
    git(repo, 'worktree', 'prune');
  });

  it('huérfanos: sin Workspace no hay muestra', () => {
    const r = esc(laboratorioAislamiento, 'huerfanos').ejecutar({ ...base, workspace: null }) as { suficiente: boolean; hallazgos: unknown[] };
    assert.deepEqual([r.suficiente, r.hallazgos.length], [false, 0]);
  });
});

describe('laboratorio de la analítica', () => {
  const registro = (id: string, o: { recomendadas?: string[]; preparadas?: string[]; usadas?: string[]; delegada?: boolean } = {}): RegistroTarea => ({
    task_id: id, status: 'completed',
    classification: { intent: 'implement_feature', created_at: '2026-01-02T03:04:05+00:00', recommended_skills: o.recomendadas ?? [], subtasks: [] },
    delegation: o.delegada === false ? null : { completed_at: '2026-01-02T03:10:00+00:00', executions: [{ subtask_id: 's1', status: 'completed', prepared_skills: o.preparadas ?? [], used_skills: o.usadas ?? [] }] },
  });
  const ctx = (registros: RegistroTarea[], metricas = { total_tasks: registros.length, delegated_tasks: registros.filter((r) => r.delegation).length }): ContextoAnalitica =>
    ({ ...base, registros: () => registros, runsPorTarea: () => ({}), metricas: () => metricas });
  const coherencia = (c: ContextoAnalitica) => esc(laboratorioAnalitica, 'coherencia').ejecutar(c) as { suficiente: boolean; hallazgos: { clave: string; severidad: string }[]; metricas: Record<string, number> };

  it('datos coherentes: recomendadas ≥ preparadas ≥ usadas y totales que cuadran → sin hallazgos', () => {
    const r = coherencia(ctx([registro('a', { recomendadas: ['pdf', 'docx'], preparadas: ['pdf'], usadas: ['pdf'] }), registro('b', { recomendadas: ['pdf'], preparadas: ['pdf', 'docx'] }), registro('c', { delegada: false, recomendadas: ['xlsx'] })]));
    assert.deepEqual(r.hallazgos, []);
    assert.equal(r.metricas['usadas_sin_preparar'], 0);
    assert.equal(r.suficiente, true);
  });

  it('avisa de una skill usada sin prepararse (media) y de totales que no cuadran con el almacén (alta)', () => {
    const r = coherencia(ctx([registro('a', { usadas: ['pdf'] })], { total_tasks: 1, delegated_tasks: 0 }));
    assert.deepEqual(r.hallazgos.map((h) => [h.clave, h.severidad]), [['usadas-sin-preparar', 'media'], ['totales-no-cuadran', 'alta']]);
  });

  it('una skill que se prepara más de lo que se recomienda es solo un aviso bajo', () => {
    const r = coherencia(ctx([registro('a', { recomendadas: ['pdf'], preparadas: ['pdf'] }), registro('b', { recomendadas: ['docx'], preparadas: ['pdf'] })]));
    assert.deepEqual(r.hallazgos.map((h) => [h.clave, h.severidad]), [['preparadas-sin-recomendar', 'baja']]);
  });
});

describe('laboratorio de producción', () => {
  const tarea = (i: number, o: Partial<TareaAnonima>): TareaAnonima => ({ hash: `h${i}`, prompt: 'x', agenteHumano: null, agenteReal: null, skillsHoja: [], estado: 'completada', exito: true, retrabajo: false, revisada: false, clasificacionHumana: {}, ...o });
  const concordancia = async (tareas: TareaAnonima[]) => await esc(laboratorioProduccion, 'concordancia').ejecutar({ ...base, tareas: async () => tareas }) as { suficiente: boolean; hallazgos: { clave: string; severidad: string }[]; metricas: Record<string, number | null> };

  it('concordante: acierto = completada sin re-trabajo y fallida = no acertada → sin hallazgos', async () => {
    const t = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? tarea(i, { estado: 'fallida', exito: false }) : tarea(i, {})));
    const r = await concordancia(t);
    assert.equal(r.suficiente, true);
    assert.equal(r.metricas['concordancia'], 1);
    assert.deepEqual(r.hallazgos, []);
  });

  it('discrepante: completadas que produccion cuenta como re-trabajo, con Wilson, dan un hallazgo medio', async () => {
    const t = Array.from({ length: 40 }, (_, i) => tarea(i, i < 30 ? { exito: false, retrabajo: true, revisada: i < 20 } : {}));
    const r = await concordancia(t);
    assert.equal(r.metricas['falsos_retrabajo'], 30);
    assert.deepEqual(r.hallazgos.map((h) => [h.clave, h.severidad]), [['acierto-discrepa', 'media'], ['acierto-discrepa-revisadas', 'media']]);
  });

  it('con muestra corta da métricas pero no hallazgos', async () => {
    const r = await concordancia(Array.from({ length: 8 }, (_, i) => tarea(i, { exito: false, retrabajo: true })));
    assert.equal(r.suficiente, false);
    assert.equal(r.metricas['concordancia'], 0);
    assert.deepEqual(r.hallazgos, []);
  });

  it('las tareas sin terminar no cuentan', async () => {
    const r = await concordancia([tarea(1, { estado: 'encolada', exito: null }), tarea(2, {})]);
    assert.equal(r.metricas['terminadas'], 1);
  });
});
