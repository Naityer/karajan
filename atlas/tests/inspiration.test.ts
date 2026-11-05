import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import { Biblioteca } from '../src/biblioteca';
import { ejecutar } from '../src/cli';

const dir = mkdtempSync(join(tmpdir(), 'kj-inspiration-'));

/** Un resources.db mínimo con el esquema real: familia (capability) con una skill hija, otra suelta, una pendiente de revisión. */
function crearBiblioteca(): Biblioteca {
  const ruta = join(dir, 'resources.db');
  const db = new DatabaseSync(ruta);
  db.exec(`
    CREATE TABLE resources (id TEXT PRIMARY KEY, slug TEXT, name TEXT, kind TEXT, source TEXT, repo_url TEXT, summary TEXT, tags_json TEXT, requirements_json TEXT, capabilities_json TEXT,
      compatible_runtimes_json TEXT, install_strategy TEXT, status TEXT, installations_json TEXT, visible_agent_ids_json TEXT, metadata_json TEXT, created_at TEXT, updated_at TEXT,
      parent_resource_id TEXT, source_url TEXT, indexed_at TEXT, index_status TEXT);
    CREATE TABLE resource_groups (id TEXT PRIMARY KEY, name TEXT, description TEXT, parent_id TEXT, sort_order INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE resource_group_assignments (resource_id TEXT PRIMARY KEY, group_id TEXT);
    CREATE TABLE resource_operations (operation_id TEXT PRIMARY KEY, resource_id TEXT, action TEXT, status TEXT, detail TEXT, targets_json TEXT, metadata_json TEXT, created_at TEXT);
    CREATE TABLE resource_preferences (preference_key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT);
    CREATE TABLE discovery_sources (id TEXT PRIMARY KEY, name TEXT, url TEXT, provider TEXT, source_type TEXT, description TEXT, enabled INTEGER, available INTEGER, requires_credentials INTEGER, setup_hint TEXT, metadata_json TEXT, created_at TEXT, updated_at TEXT);
  `);
  const ins = db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const fila = (id: string, kind: string, nombre: string, extra: { padre?: string; meta?: object; estado?: string; runtimes?: string[]; fuente?: string; activo?: boolean } = {}) =>
    ins.run(id, nombre, nombre, kind, extra.fuente ?? 'github', `https://github.com/x/${nombre}`, `Resumen de ${nombre}`, JSON.stringify(['testing']), '[]', JSON.stringify(['tdd']), JSON.stringify(extra.runtimes ?? ['claude']), 'manual', extra.estado ?? 'available', '[]', '[]',
      JSON.stringify(extra.meta ?? {}), '2026-11-01', '2026-11-01', extra.padre ?? null, null, null, extra.activo === false ? 'stale' : 'active');
  fila('r1', 'capability', 'superpowers', { meta: { github_stars: 5000, validity: { state: 'accepted' } }, estado: 'installed' });
  fila('r2', 'skill', 'test-driven-development', { padre: 'r1', meta: { github_stars: 5000 }, estado: 'installed' });
  fila('r3', 'skill', 'ponytail', { meta: { github_stars: 120, validity: { state: 'pending_review', reasons: ['menos de 500 estrellas'] } }, runtimes: ['claude', 'codex'] });
  fila('r4', 'skill', 'vieja', { activo: false });
  db.exec(`INSERT INTO resource_groups VALUES ('g0', 'Metodología', 'Cómo trabajar', NULL, 0, '', ''), ('g1', 'Testing', '', 'g0', 0, '', '');
    INSERT INTO resource_group_assignments VALUES ('r1', 'g1'), ('r3', 'g0');
    INSERT INTO resource_operations VALUES ('o1', 'r1', 'install', 'ok', 'instalada', '[]', '{}', '2026-11-02T10:00:00');
    INSERT INTO resource_preferences VALUES ('artifact_validity_policy', '{"min_github_stars":500,"stars_enabled":true,"required_runtimes":["claude"]}', '');
    INSERT INTO discovery_sources VALUES ('s1', 'GitHub trending', 'https://github.com/trending', 'github', 'feed', '', 1, 1, 0, NULL, '{}', '', ''), ('s2', 'Reddit', 'https://reddit.com', 'reddit', 'feed', '', 0, 0, 1, 'falta la clave', '{}', '', '');`);
  db.close();
  return new Biblioteca(ruta);
}

const b = crearBiblioteca();
after(() => { b.cerrar(); rmSync(dir, { recursive: true, force: true }); });

describe('Biblioteca (lectura para Inspiration)', () => {

  it('lista solo lo activo y filtra por tipo, runtime, validez y texto', () => {
    assert.deepEqual(b.listar().map((r) => r.nombre), ['ponytail', 'superpowers', 'test-driven-development']);
    assert.deepEqual(b.listar({ tipo: 'skill' }).map((r) => r.nombre), ['ponytail', 'test-driven-development']);
    assert.deepEqual(b.listar({ runtime: 'codex' }).map((r) => r.nombre), ['ponytail']);
    assert.deepEqual(b.listar({ validez: 'pending_review' }).map((r) => r.nombre), ['ponytail']);
    assert.deepEqual(b.listar({ q: 'PONY' }).map((r) => r.nombre), ['ponytail']);
    assert.equal(b.listar({ limite: 1 }).length, 1);
  });

  it('el resumen trae grupo, validez con motivos y estrellas heredadas en la hija', () => {
    const [pony, sp, tdd] = b.listar();
    assert.deepEqual([pony!.grupo, pony!.validez, pony!.motivos_validez], ['g0', 'pending_review', ['menos de 500 estrellas']]);
    assert.deepEqual([sp!.grupo, sp!.instalaciones, sp!.heredadas], ['g1', 0, false]);
    assert.deepEqual([tdd!.padre, tdd!.heredadas, tdd!.estrellas], ['r1', true, 5000]);
  });

  it('detalle por id o slug trae hijos y operaciones; uno que no existe es null', () => {
    const d = b.detalle('superpowers')!;
    assert.equal(d.recurso.id, 'r1');
    assert.deepEqual(d.hijos.map((h) => h.nombre), ['test-driven-development']);
    assert.equal(d.operaciones[0]!.accion, 'install');
    assert.equal(b.detalle('r3')!.recurso.nombre, 'ponytail');
    assert.equal(b.detalle('nada'), null);
  });

  it('grupos con su recuento, recuentos globales, fuentes del radar y preferencias', () => {
    assert.deepEqual(b.grupos().map((g) => [g.id, g.padre, g.recursos]), [['g0', null, 1], ['g1', 'g0', 1]]);
    const c = b.recuentos();
    assert.deepEqual([c.total, c.tipo['skill'], c.tipo['capability'], c.validez['pending_review'], c.validez['accepted']], [3, 2, 1, 1, 1]);
    assert.deepEqual(b.fuentes().map((f) => [f.nombre, f.activa, f.requiere_credenciales]), [['GitHub trending', true, false], ['Reddit', false, true]]);
    assert.deepEqual((b.preferencias()['artifact_validity_policy'] as { min_github_stars: number }).min_github_stars, 500);
  });

  it('sin base de datos devuelve vacíos y no lanza', () => {
    const vacia = new Biblioteca(null);
    assert.deepEqual([vacia.listar(), vacia.grupos(), vacia.fuentes(), vacia.detalle('x')], [[], [], [], null]);
  });
});

const servidor = (rutas: Record<string, unknown>) => async (url: string) => {
  const ruta = url.replace('http://k', '');
  const clave = Object.keys(rutas).sort((a, b) => b.length - a.length).find((r) => ruta.startsWith(r));
  return { ok: !!clave, status: clave ? 200 : 404, json: async () => (clave ? rutas[clave] : { detail: 'no' }) };
};
const correr = async (args: string[], rutas: Record<string, unknown>) => {
  let texto = '';
  const urls: string[] = [];
  const f = servidor(rutas);
  await ejecutar(args, { fetch: async (u, i) => { urls.push(u.replace('http://k', '')); return f(u); }, escribir: (x) => { texto += `${x}\n`; }, api: 'http://k' });
  return { texto, urls };
};

describe('kj inspiration (módulo)', () => {
  const rutas = {
    '/resources/index': b.recuentos(), '/resource-groups': b.grupos(), '/resources/discovery/sources': { fuentes: b.fuentes() }, '/resources/review': b.listar({ validez: 'pending_review' }),
    '/resources/validity-policy': { preferencias: b.preferencias() }, '/resources/superpowers': b.detalle('superpowers'), '/resources': b.listar(),
  };

  it('resumen: barras por tipo, estado, validez y grupo', async () => {
    const { texto } = await correr(['inspiration', 'resumen'], rutas);
    assert.match(texto, /Inspiration · resumen {2}· {2}3 recursos activos/);
    assert.match(texto, /skill +█+·* 2/);
    assert.match(texto, /pending_review/);
  });

  it('lista traduce los filtros a la consulta y marca las estrellas heredadas', async () => {
    const { texto, urls } = await correr(['inspiration', 'lista', '--tipo', 'skill', '--buscar', 'tdd', '--limite', '5'], rutas);
    assert.deepEqual(urls, ['/resources?kind=skill&q=tdd&limit=5']);
    assert.match(texto, /test-driven-development +│ skill +│ installed +│ 5000★\*/);
    assert.match(texto, /★\* = estrellas heredadas/);
  });

  it('arbol: grupo → artefacto → componentes, y «Sin grupo» aparte; --grupo acota', async () => {
    const { texto } = await correr(['inspiration', 'arbol'], rutas);
    assert.match(texto, /Biblioteca\n└─ Metodología {2}\(1\)\n {3}├─ Testing {2}\(1\)\n {3}│ {2}└─ superpowers {2}capability · 5000★ · instalado\n {3}│ {5}└─ test-driven-development {2}skill\n {3}└─ ponytail {2}skill · 120★/);
    assert.doesNotMatch((await correr(['inspiration', 'arbol', '--grupo', 'Metodología'], rutas)).texto, /Sin grupo/);
  });

  it('arbol --grupo acepta un grupo hijo (por nombre o id), pide solo sus recursos y avisa si no existe', async () => {
    const r = await correr(['inspiration', 'arbol', '--grupo', 'testing'], rutas);
    assert.deepEqual(r.urls, ['/resource-groups', '/resources?limit=500&group=g1']);
    assert.match(r.texto, /Biblioteca\n└─ Testing {2}\(1\)/);
    await assert.rejects(correr(['inspiration', 'arbol', '--grupo', 'nada'], rutas), /grupo desconocido: nada/);
  });

  it('refresco muestra el último refresco y el progreso de la ejecución', async () => {
    const pref = { resource_refresh_status_v1: { last_run_at: '2026-11-05T19:47:48+00:00', last_analyzed: 25, last_updated: 0, last_failed: 25 }, resource_refresh_run_v1: { status: 'interrupted', total: 263, processed: 14 } };
    const { texto } = await correr(['inspiration', 'refresco'], { '/resources/refresh/settings': { preferencias: pref } });
    assert.match(texto, /última ejecución interrupted/);
    assert.match(texto, /cuándo +│ 2026-11-05T19:47/);
    assert.match(texto, /fallidos +│ +25/);
    assert.match(texto, /14 de 263/);
  });

  it('validez y revisión avisan de lo que no está evaluado en vez de mostrar tablas vacías', async () => {
    const sin = { '/resources/index': { ...b.recuentos(), validez: { 'sin dato': 7 } }, '/resources/validity-policy': { preferencias: {} }, '/resources/review': [] };
    assert.match((await correr(['inspiration', 'validez'], sin)).texto, /No hay política guardada/);
    assert.match((await correr(['inspiration', 'revision'], sin)).texto, /7 recursos no tienen estado de validez guardado/);
  });

  it('grupos, ver, radar, revision y validez', async () => {
    assert.match((await correr(['inspiration', 'grupos'], rutas)).texto, /Taxonomía\n└─ Metodología {2}\(1\)\n {3}└─ Testing {2}\(1\)/);
    const v = (await correr(['inspiration', 'ver', 'superpowers'], rutas)).texto;
    assert.match(v, /Inspiration · superpowers {2}· {2}capability · installed/);
    assert.match(v, /Componentes \(1\)/);
    assert.match(v, /install +│ ok +│ instalada/);
    assert.match((await correr(['inspiration', 'radar'], rutas)).texto, /Reddit +│ reddit +│ feed +│ no +│ no +│ sí +│ falta la clave/);
    const rev = (await correr(['inspiration', 'revision'], rutas)).texto;
    assert.match(rev, /1 esperan decisión/);
    assert.match(rev, /ponytail +│ skill +│ 120★ +│ menos de 500 estrellas/);
    const val = (await correr(['inspiration', 'validez'], rutas)).texto;
    assert.match(val, /artifact_validity_policy\.min_github_stars +│ 500/);
    assert.match(val, /artifact_validity_policy\.required_runtimes +│ claude/);
  });

  it('ver sin id es error de uso y --json entrega los datos', async () => {
    await assert.rejects(correr(['inspiration', 'ver'], rutas), /uso: kj inspiration ver/);
    const j = JSON.parse((await correr(['inspiration', 'radar', '--json'], rutas)).texto);
    assert.equal(j.origen, 'inspiration');
    assert.equal(j.datos.length, 2);
  });
});
