import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Almacen } from '../src/almacen';
import { Delegador } from '../src/delegar';
import { clasificar } from '../src/heuristica';
import { Perfiles, perfilPorDefecto } from '../src/perfiles';
import type { Disponibilidad, Ejecutor, Proveedor } from '../src/proveedores';
import { detectarAreas, elegirRegla, nivelRegla, presetDominio } from '../src/reglas';

/** Reglas, perfiles compartidos y delegación del paquete. Las reglas se comparan con lo que decide el Python (fixtures/reglas.json). */
const base = mkdtempSync(join(tmpdir(), 'karajan-perfiles-'));
after(() => rmSync(base, { recursive: true, force: true }));

interface Caso { prompt: string; areas: string[]; dominios: string[]; intencion: string; subtareas: { nivel: number; regla: string | null; entidad: string | null }[] }
const casos = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'reglas.json'), 'utf8')) as Caso[];

describe('reglas por dominio: paridad con Python', () => {
  for (const caso of casos) {
    it(caso.prompt, () => {
      assert.deepEqual(detectarAreas(caso.prompt), caso.areas);
      const c = clasificar(caso.prompt);
      assert.deepEqual(c.domain, caso.dominios);
      const elegidas = c.subtasks.map((st) => elegirRegla(presetDominio(), { dominios: c.domain, intencion: c.intent, nivel: nivelRegla(c.complexity_level, st.complexity), prompt: caso.prompt })?.entidad.id ?? null);
      assert.deepEqual(elegidas, caso.subtareas.map((s) => s.entidad));
    });
  }
  it('ignora reglas desactivadas o con agente inexistente', () => {
    const p = presetDominio();
    p.rules = [{ id: 'off', entity_id: 'dominio-claude', enabled: false }, { id: 'ghost', entity_id: 'nadie' }];
    assert.equal(elegirRegla(p, { dominios: [], intencion: 'x', nivel: 3 }), null);
  });
});

describe('perfiles compartidos (routing_layout.json)', () => {
  const ruta = join(base, 'routing_layout.json');
  const perfiles = new Perfiles(ruta);

  it('lee un fichero antiguo sin perfiles y crea el preset por dominio como perfil por defecto', () => {
    writeFileSync(ruta, JSON.stringify({ entities: [{ id: 'a', role: 'worker', provider: 'codex' }] }));
    assert.equal(perfiles.leer().profiles[0]!.id, 'current');
    const l = perfiles.aplicarPresetDominio();
    assert.equal(l.default_profile_id, 'por-dominio');
    assert.equal(perfilPorDefecto(l).rules?.length, 4);
    assert.ok(existsSync(`${ruta}.bak`));
  });

  it('conserva las reglas cuando el lienzo nativo guarda sin ellas', () => {
    const l = perfiles.leer();
    const sinReglas = l.profiles.map(({ rules: _r, ...p }) => p);
    perfiles.guardar({ profiles: sinReglas, active_profile_id: l.active_profile_id, default_profile_id: l.default_profile_id });
    assert.equal(perfilPorDefecto(perfiles.leer()).rules?.length, 4);
  });

  it('rechaza lo inválido sin tocar el fichero', () => {
    const antes = readFileSync(ruta, 'utf8');
    assert.throws(() => perfiles.guardar({ profiles: [{ id: 'mal id', name: 'x', entities: [] }] }));
    assert.throws(() => perfiles.guardar({ profiles: [{ id: 'p', name: 'x', entities: [], rules: [{ id: 'r', entity_id: 'e', level_min: 9 }] }], active_profile_id: 'p', default_profile_id: 'p' }));
    assert.throws(() => perfiles.guardar({ profiles: [{ id: 'p', name: 'x', entities: [] }], active_profile_id: 'otro' }));
    assert.equal(readFileSync(ruta, 'utf8'), antes);
  });

  it('un fichero roto cae al .bak', () => {
    writeFileSync(ruta, '{roto');
    assert.equal(perfiles.leer().default_profile_id, 'por-dominio');
  });
});

describe('delegación real', () => {
  const perfiles = new Perfiles(join(base, 'deleg', 'routing_layout.json'));
  perfiles.aplicarPresetDominio();
  const almacen = new Almacen(join(base, 'deleg', 'task_logs.db'));
  after(() => almacen.cerrar());
  const llamadas: { proveedor: string; modelo: string; cwd: string }[] = [];
  const ejecutor: Ejecutor = async (p, modelo, _i, op) => { llamadas.push({ proveedor: p.nombre, modelo, cwd: op.cwd }); return { salida: `ok ${p.nombre}`, error: null, latenciaMs: 5, modelo }; };
  const todos = (p: Proveedor): Disponibilidad => ({ nombre: p.nombre, etiqueta: p.etiqueta, gratis: p.gratis, disponible: true, ruta: 'x', motivo: null, login: p.login });
  const delegador = new Delegador({ almacen, perfiles, config: () => null as never, raiz: base, ejecutor, disponible: todos });

  it('elige el agente por la regla, ejecuta y lo registra todo', async () => {
    const plan = delegador.delegar('Crea un endpoint REST en la API para listar usuarios');
    assert.equal(plan.status, 'delegated');
    assert.ok(plan.asignaciones.every((a) => a.proveedor === 'codex' && a.regla === 'backend-oficina'));
    await Promise.all([...delegador.pendientes]);
    const t = almacen.tarea(plan.task_id)!;
    assert.equal(t.status, 'completed');
    assert.equal(almacen.runs(plan.task_id).length, plan.asignaciones.length);
    assert.ok(almacen.decisiones(plan.task_id).some((d) => String(d['decision']).startsWith('rule:backend-oficina')));
    assert.ok(llamadas.every((l) => l.cwd === base));
  });

  it('interfaces a Claude y lo trivial a Qwen; un agente no disponible pasa al respaldo', async () => {
    assert.ok(delegador.planificar('Diseña la interfaz del dashboard con componentes React y animaciones').asignaciones.every((a) => a.proveedor === 'claude-cli'));
    assert.ok(delegador.planificar('Renombra una variable').asignaciones.every((a) => a.proveedor === 'ollama-qwen'));
    const sinOllama = new Delegador({ almacen, perfiles, config: () => null as never, raiz: base, ejecutor, disponible: (p) => ({ ...todos(p), disponible: p.nombre !== 'ollama-qwen', motivo: 'falta el modelo' }) });
    const a = sinOllama.planificar('Renombra una variable').asignaciones[0]!;
    assert.equal(a.proveedor, 'codex');
    assert.match(a.motivo, /respaldo codex/);
  });

  it('confina la carpeta de trabajo y respeta el agente forzado', () => {
    assert.throws(() => delegador.delegar('Renombra una variable', { cwd: tmpdir() === base ? '/' : join(base, '..') }), /dentro de/);
    assert.ok(delegador.planificar('Renombra una variable', 'dominio-claude').asignaciones.every((a) => a.proveedor === 'claude-cli'));
    assert.throws(() => delegador.planificar('x y z', 'no-existe'), /no existe/);
  });
});

describe('motivo de fallo de un CLI', () => {
  it('se queda con la línea de error y no con los avisos', async () => {
    const { motivoFallo } = await import('../src/proveedores');
    const stderr = 'x ERROR codex_core: failed to load skill C:/a/SKILL.md\nwarning: algo\nERROR: {"message":"The model is not supported"}\n';
    assert.equal(motivoFallo(stderr), 'ERROR: {"message":"The model is not supported"}');
    assert.equal(motivoFallo('a\nb\nc\nd'), 'b · c · d');
  });
});
