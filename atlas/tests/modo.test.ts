import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { AtlasDev } from '../src/atlas-dev';
import { Guardian, leerModo } from '../src/modo';
import { Pasarela } from '../src/pasarela-borradores';
import { registrar } from '../src/servidor';
import { atlasFalso } from './ayuda-atlas';

const dir = mkdtempSync(join(tmpdir(), 'karajan-modo-'));
// El servidor deja sus SQLite abiertas (no tiene cierre): en Windows el temporal puede no borrarse.
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* bases abiertas */ } });

describe('modo producción', () => {
  it('por defecto es producción; solo el fichero lo cambia', () => {
    const d = mkdtempSync(join(dir, 'm-'));
    assert.equal(leerModo(d), 'produccion');
    writeFileSync(join(d, 'modo.json'), '{"modo":"desarrollo"}');
    assert.equal(leerModo(d), 'desarrollo');
    writeFileSync(join(d, 'modo.json'), 'roto');
    assert.equal(leerModo(d), 'produccion');
  });

  it('deja pasar con una tarea aceptada; sin ella 423 y la mutación queda como borrador', async () => {
    const d = mkdtempSync(join(dir, 'g-'));
    const a = atlasFalso([{ id: 'ok1', estado: 'encolada' }, { id: 'bor', estado: 'borrador' }]);
    const atlas = new AtlasDev('http://atlas', a.fetch);
    const g = new Guardian(d, atlas, new Pasarela(atlas, join(d, 'b.json')));
    assert.deepEqual(await g.exigir({ headers: { 'x-karajan-tarea': 'ok1' }, body: {} }, 'PUT /x'), { modo: 'produccion', tarea: 'ok1' });
    assert.deepEqual(await g.exigir({ body: { tarea: 'ok1' } }, 'PUT /x'), { modo: 'produccion', tarea: 'ok1' });
    await assert.rejects(g.exigir({ headers: { 'x-karajan-tarea': 'bor' }, body: { a: 1 } }, 'PUT /x'), (e: Error & { status?: number }) => e.status === 423 && /tarea aceptada/.test(e.message));
    const borradores = [...a.tareas.values()].filter((t) => t.prompt?.includes('Origen: karajan:modo:'));
    assert.equal(borradores.length, 1);
    assert.match(borradores[0]!.prompt!, /"a": 1/);
    // La misma petición no abre otro borrador.
    await assert.rejects(g.exigir({ body: { a: 1 } }, 'PUT /x'));
    assert.equal([...a.tareas.values()].filter((t) => t.prompt?.includes('Origen: karajan:modo:')).length, 1);
    writeFileSync(join(d, 'modo.json'), '{"modo":"desarrollo"}');
    assert.deepEqual(await g.exigir({ body: {} }, 'PUT /x'), { modo: 'desarrollo', tarea: null });
  });
});

describe('servidor del paquete en producción', () => {
  type Manejador = (req: Record<string, unknown>, reply: { code(n: number): unknown }) => unknown;
  const rutas = new Map<string, Manejador>();
  let errores: (e: Error & { status?: number; extra?: Record<string, unknown> }, req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => unknown = () => undefined;
  const a = atlasFalso([{ id: 'acep', estado: 'ejecutando' }]);
  const fetchOriginal = globalThis.fetch;
  const entorno: Record<string, string | undefined> = {};
  const datos = join(dir, 'paquete');

  before(async () => {
    for (const k of ['ATLAS_KARAJAN_DATA', 'ATLAS_WORKSPACE', 'ATLAS_KARAJAN_LAYOUT', 'ATLAS_DEV_API', 'ATLAS_KARAJAN_RESOURCES']) entorno[k] = process.env[k];
    process.env['ATLAS_KARAJAN_DATA'] = join(dir, 'no-existe');
    process.env['ATLAS_WORKSPACE'] = dir;
    delete process.env['ATLAS_KARAJAN_LAYOUT'];
    process.env['ATLAS_DEV_API'] = 'http://127.0.0.1:4100';
    globalThis.fetch = a.fetch as unknown as typeof fetch;
    const app = {
      get: (r: string, f: Manejador) => rutas.set(`GET ${r}`, f), post: (r: string, f: Manejador) => rutas.set(`POST ${r}`, f), put: (r: string, f: Manejador) => rutas.set(`PUT ${r}`, f),
      setErrorHandler: (f: typeof errores) => { errores = f; },
    };
    await registrar(app as never, { id: 'karajan', version: '0.7.0', datos });
  });
  after(() => {
    globalThis.fetch = fetchOriginal;
    for (const [k, v] of Object.entries(entorno)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });

  const llamar = async (clave: string, req: Record<string, unknown> = {}) => {
    try { return { status: 200, body: await rutas.get(clave)!({ query: {}, params: {}, headers: {}, body: null, ...req }, { code: () => undefined }) as Record<string, unknown> }; } catch (e) {
      let r: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
      errores(e as Error, null, { code: (n) => ({ send: (b) => { r = { status: n, body: b as Record<string, unknown> }; } }) });
      return r;
    }
  };

  it('PUT /routing-layout sin tarea aceptada: 423 con el borrador; con ella, guarda', async () => {
    const layout = (await llamar('GET /routing-layout')).body;
    const r = await llamar('PUT /routing-layout', { body: { ...layout, profiles: [...(layout['profiles'] as object[]), { id: 'nuevo', name: 'Nuevo', entities: [] }] } });
    assert.equal(r.status, 423);
    assert.ok(r.body['borrador']);
    assert.ok(a.tareas.get(String(r.body['borrador']))!.prompt!.includes('PUT /routing-layout'));
    const ok = await llamar('PUT /routing-layout', { headers: { 'x-karajan-tarea': 'acep' }, body: { ...layout, profiles: [...(layout['profiles'] as object[]), { id: 'nuevo', name: 'Nuevo', entities: [] }] } });
    assert.equal(ok.status, 200);
    assert.ok((ok.body['profiles'] as { id: string }[]).some((p) => p.id === 'nuevo'));
  });

  it('las simulaciones y el laboratorio no necesitan tarea; aplicar la rotación sí', async () => {
    assert.equal((await llamar('POST /skills/rotar', { body: {} })).status, 200);
    assert.equal((await llamar('POST /skills/rotar', { body: { aplicar: true } })).status, 423);
    assert.equal((await llamar('POST /routing-layout/desde-texto', { body: { texto: 'Claude para lo complejo' } })).status, 200);
    assert.equal((await llamar('POST /routing-layout/desde-texto', { body: { texto: 'Claude para lo complejo', aplicar: true } })).status, 423);
    const comp = (await llamar('GET /laboratorio/componentes')).body;
    assert.equal(comp['modo'], 'produccion');
    assert.ok((comp['componentes'] as { id: string }[]).some((c) => c.id === 'delegador'));
  });

  it('la calibración guarda solo el hash de la tarea', async () => {
    assert.equal((await llamar('POST /laboratorio/calibracion', { body: { tarea: 'abc', respuesta: 'quizas' } })).status, 422);
    assert.equal((await llamar('POST /laboratorio/calibracion', { body: { tarea: 'abc', respuesta: 'no', propuesta: ['pdf'], correccion: ['docx'] } })).status, 200);
    const db = new DatabaseSync(join(datos, 'laboratorio', 'laboratorio.db'), { readOnly: true });
    const filas = db.prepare('SELECT tarea_hash FROM calibracion').all() as { tarea_hash: string }[];
    db.close();
    assert.equal(filas.length, 1);
    assert.match(filas[0]!.tarea_hash, /^[0-9a-f]{16}$/);
  });
});
