import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import { registrar } from '../src/servidor';

/** Las rutas /resources/* y /resource-groups del paquete (solo lectura), con un servidor falso y todo en un directorio temporal. */
type Manejador = (req: Record<string, unknown>, reply: { code(n: number): unknown }) => unknown;
type Errores = (e: Error, req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => unknown;
const dir = mkdtempSync(join(tmpdir(), 'karajan-insp-api-'));
const fetchOriginal = globalThis.fetch;
const claves = ['ATLAS_KARAJAN_DATA', 'ATLAS_WORKSPACE', 'ATLAS_KARAJAN_LAYOUT', 'ATLAS_DEV_API', 'ATLAS_KARAJAN_RESOURCES', 'ATLAS_LIMITES_PLAN', 'KARAJAN_LIMITES_PLAN'];
const guardado = Object.fromEntries(claves.map((k) => [k, process.env[k]]));

function crearDb(ruta: string) {
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
    INSERT INTO resources VALUES ('r1', 'ponytail', 'ponytail', 'skill', 'github', 'https://github.com/x/ponytail', 'Mínimo código', '["codigo"]', '[]', '[]', '["claude"]', 'manual', 'available', '[]', '[]',
      '{"validity":{"state":"pending_review","reasons":["pocas estrellas"]}}', '', '', NULL, NULL, NULL, 'active');
    INSERT INTO resource_groups VALUES ('g1', 'Eficiencia', '', NULL, 0, '', '');
    INSERT INTO resource_group_assignments VALUES ('r1', 'g1');
    INSERT INTO resource_preferences VALUES ('artifact_validity_policy', '{"min_github_stars":500}', ''), ('otra_cosa', '1', '');
    INSERT INTO discovery_sources VALUES ('s1', 'GitHub', 'https://github.com', 'github', 'feed', '', 1, 1, 0, NULL, '{}', '', '');`);
  db.close();
}

async function montar(subdir: string, resources: string) {
  const datos = join(dir, subdir, 'paquete');
  mkdirSync(datos, { recursive: true });
  writeFileSync(join(datos, 'modo.json'), '{"modo":"desarrollo"}\n');
  process.env['ATLAS_KARAJAN_DATA'] = join(dir, subdir, 'no-existe');
  process.env['ATLAS_WORKSPACE'] = join(dir, subdir);
  delete process.env['ATLAS_KARAJAN_LAYOUT']; delete process.env['KARAJAN_LIMITES_PLAN'];
  process.env['ATLAS_DEV_API'] = 'http://127.0.0.1:1';
  process.env['ATLAS_LIMITES_PLAN'] = join(dir, subdir, 'limites-plan.json');
  process.env['ATLAS_KARAJAN_RESOURCES'] = resources;
  globalThis.fetch = (async () => { throw new Error('sin Atlas dev'); }) as unknown as typeof fetch;
  const rutas = new Map<string, Manejador>();
  let errores: Errores = () => undefined;
  const app = {
    get: (r: string, f: Manejador) => rutas.set(`GET ${r}`, f), post: (r: string, f: Manejador) => rutas.set(`POST ${r}`, f), put: (r: string, f: Manejador) => rutas.set(`PUT ${r}`, f),
    setErrorHandler: (f: Errores) => { errores = f; },
  };
  await registrar(app as never, { id: 'karajan', version: '0.10.0', datos });
  return async (clave: string, req: Record<string, unknown> = {}) => {
    let codigo = 200;
    try {
      const cuerpo = await rutas.get(clave)!({ query: {}, params: {}, headers: {}, body: null, ...req }, { code: (n: number) => { codigo = n; } });
      return { status: codigo, body: cuerpo as never as Record<string, unknown> & unknown[] };
    } catch (e) {
      let r = { status: 0, body: {} as Record<string, unknown> & unknown[] };
      errores(e as Error, null, { code: (n) => ({ send: (b) => { r = { status: n, body: b as never }; } }) });
      return r;
    }
  };
}

after(() => {
  globalThis.fetch = fetchOriginal;
  for (const [k, v] of Object.entries(guardado)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* en Windows las bases abiertas no se dejan borrar; es un temporal */ }
});

describe('API de Inspiration (solo lectura)', () => {
  it('con resources.db: catálogo con filtros, índice, grupos, detalle, radar, revisión y política', async () => {
    mkdirSync(join(dir, 'a'), { recursive: true });
    crearDb(join(dir, 'a', 'resources.db'));
    const llamar = await montar('a', join(dir, 'a', 'resources.db'));
    const lista = await llamar('GET /resources', { query: { kind: 'skill', q: 'PONY', limit: '10' } });
    assert.equal(lista.status, 200);
    assert.deepEqual((lista.body as unknown as { nombre: string; grupo: string }[]).map((r) => [r.nombre, r.grupo]), [['ponytail', 'g1']]);
    assert.equal(((await llamar('GET /resources', { query: { kind: 'reference' } })).body as unknown[]).length, 0);
    assert.equal(((await llamar('GET /resources', { query: { group: 'g1' } })).body as unknown[]).length, 1);
    assert.equal(((await llamar('GET /resources', { query: { group: 'otro' } })).body as unknown[]).length, 0);
    assert.equal((await llamar('GET /resources/index')).body['total'], 1);
    assert.deepEqual(((await llamar('GET /resource-groups')).body as unknown as { id: string; recursos: number }[]).map((g) => [g.id, g.recursos]), [['g1', 1]]);
    assert.equal(((await llamar('GET /resources/:id', { params: { id: 'ponytail' } })).body['recurso'] as { id: string }).id, 'r1');
    assert.equal((await llamar('GET /resources/:id', { params: { id: 'nada' } })).status, 404);
    assert.deepEqual(((await llamar('GET /resources/discovery/sources')).body['fuentes'] as { nombre: string }[]).map((f) => f.nombre), ['GitHub']);
    assert.equal(((await llamar('GET /resources/review')).body as unknown[]).length, 1);
    assert.deepEqual(Object.keys((await llamar('GET /resources/validity-policy')).body['preferencias'] as object), ['artifact_validity_policy']);
  });

  it('sin resources.db responde 409 con el motivo, sin romper el resto del paquete', async () => {
    const llamar = await montar('b', join(dir, 'b', 'no-existe.db'));
    const r = await llamar('GET /resources');
    assert.equal(r.status, 409);
    assert.match(String(r.body['error'] ?? r.body['detail'] ?? JSON.stringify(r.body)), /resources\.db/);
    assert.equal((await llamar('GET /resource-groups')).status, 409);
  });

  it('las altas y el recomendador siguen siendo del Karajan nativo: 501', async () => {
    mkdirSync(join(dir, 'c'), { recursive: true });
    crearDb(join(dir, 'c', 'resources.db'));
    const llamar = await montar('c', join(dir, 'c', 'resources.db'));
    assert.equal((await llamar('POST /resources/recommend')).status, 501);
    assert.equal((await llamar('POST /resources/ingest-url')).status, 501);
  });
});
