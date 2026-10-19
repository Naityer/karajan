import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';

import { descubrirSkills, seleccionarSkills } from '../src/skills-seleccion';
import { Rotador } from '../src/rotador';
import { construirAnaliticaSkills } from '../src/analitica';
import { Delegador } from '../src/delegar';
import { Almacen } from '../src/almacen';
import { Perfiles } from '../src/perfiles';

const casa = mkdtempSync(join(tmpdir(), 'karajan-seleccion-'));
after(() => rmSync(casa, { recursive: true, force: true }));
function agregar(root: string, name: string, description: string) {
  const dir = join(casa, root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nLong body is not prompt context.`);
}

it('descubre instaladas y almacenadas, excluye las desactivadas y recomienda en secuencia', () => {
  agregar('.agents/skills', 'pdf', 'Edit PDF documents');
  agregar('.karajan/skills-almacen/codex', 'backend-builder', 'Build APIs and databases');
  agregar('.codex/skills', 'old.disabled', 'disabled');
  const catalogo = descubrirSkills(casa);
  assert.deepEqual(catalogo.map((x) => x.name), ['backend-builder', 'pdf']);
  assert.deepEqual(seleccionarSkills('Lee el PDF y modifica la API backend', catalogo), ['pdf', 'backend-builder']);
  assert.deepEqual(seleccionarSkills('Hola, responde brevemente', catalogo), []);
  const rotador = new Rotador({ casa, estado: join(casa, 'estado.json') });
  assert.equal(rotador.asegurar('backend-builder', 'codex').disponible, true);
  assert.equal(existsSync(join(casa, '.codex/skills/backend-builder/SKILL.md')), true);
});

it('cualquier nombre instalado se puede solicitar explícitamente', () => {
  const catalogo = descubrirSkills(casa);
  for (const s of catalogo) assert.ok(seleccionarSkills(`Usa ${s.name} aquí`, catalogo).includes(s.name));
});

it('ordena el análisis del repositorio antes del cambio y la seguridad al final', () => {
  const catalogo = ['frontend-builder', 'repo-analyzer', 'security-review'].map((name) =>
    ({ name, description: '', instaladaEn: ['agents'], enAlmacen: [] }));
  assert.deepEqual(seleccionarSkills('Revisa seguridad del repositorio y corrige el frontend', catalogo),
    ['repo-analyzer', 'frontend-builder', 'security-review']);
});

it('una revisión humana confirma uso sin atribuirlo a un agente', () => {
  const fecha = new Date().toISOString();
  const tarea = { task_id: 't1', status: 'completed', classification: { intent: 'test', created_at: fecha, recommended_skills: ['pdf'] },
    delegation: { completed_at: fecha, executions: [{ subtask_id: 's1', status: 'completed', prepared_skills: ['pdf'], used_skills: [] }] } };
  const a = construirAnaliticaSkills([tarea], { skillsRevisadasPorTarea: { t1: ['pdf'] }, dias: 0 });
  assert.equal((a['summary'] as { executions: number }).executions, 1);
  assert.deepEqual(a['by_agent'], []);
});

it('planifica, repone y delega una skill seleccionada sin inventar uso', async () => {
  const local = join(casa, 'e2e');
  mkdirSync(local, { recursive: true });
  agregar('e2e/.karajan/skills-almacen/codex', 'backend-builder', 'Build APIs and databases');
  agregar('e2e/.karajan/skills-almacen/codex', 'pdf', 'Read PDF documents');
  agregar('e2e/.karajan/skills-almacen/codex', 'skill-creator', 'Create a skill');
  const almacen = new Almacen(join(local, 'tasks.db'));
  const perfiles = new Perfiles(join(local, 'routing_layout.json'));
  perfiles.aplicarPresetDominio();
  const rotador = new Rotador({ casa: local, estado: join(local, 'rotador.json') });
  const instrucciones: string[] = [];
  const delegador = new Delegador({ almacen, perfiles, rotador, raiz: local, aislarGit: false,
    config: () => null as never, skillsDisponibles: () => descubrirSkills(local),
    disponible: (p) => ({ nombre: p.nombre, etiqueta: p.etiqueta, gratis: p.gratis, disponible: true, ruta: 'x', motivo: null, login: p.login }),
    ejecutor: async (_p, modelo, instruccion) => { instrucciones.push(instruccion); return { salida: 'ok', error: null, latenciaMs: 1, modelo }; },
  });
  try {
    const simple = delegador.planificar('Renombra una variable usando skill-creator');
    assert.equal(simple.asignaciones[0]?.proveedor, 'codex');
    assert.match(simple.asignaciones[0]?.motivo ?? '', /admite skills/);
    const plan = delegador.delegar('Crea un endpoint en la API backend para listar usuarios');
    assert.equal(plan.clasificacion.subtasks[0]?.recommended_skill, 'backend-builder');
    await Promise.all([...delegador.pendientes]);
    assert.equal(existsSync(join(local, '.codex/skills/backend-builder/SKILL.md')), true);
    assert.ok(instrucciones[0]?.includes('backend-builder'));
    const ejecucion = almacen.tarea(plan.task_id)?.delegation?.executions[0];
    assert.deepEqual(ejecucion?.prepared_skills, ['backend-builder']);
    assert.deepEqual(ejecucion?.used_skills, []);
  } finally { almacen.cerrar(); }
});
