import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { registrar } from '../src/servidor';

/** Las rutas /planificador/* del paquete, con un servidor falso y todo en un directorio temporal (ni ~/.atlas-dev ni datos reales). */
type Manejador = (req: Record<string, unknown>, reply: { code(n: number): unknown }) => unknown;
const dir = mkdtempSync(join(tmpdir(), 'karajan-plan-api-'));
const rutas = new Map<string, Manejador>();
let errores: (e: Error, req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => unknown = () => undefined;
const entorno: Record<string, string | undefined> = {};
const fetchOriginal = globalThis.fetch;

type PlanHttp = { modo: string; solicitado: string; pasos: { tipo: string; actor: string }[]; actores: Record<string, { agente: string; nivel: string }>; errores: string[]; modificadores: string[]; alternativas: unknown[]; motivo: string };

describe('API del planificador', () => {
  const datos = join(dir, 'paquete');
  const llamar = async (clave: string, req: Record<string, unknown> = {}) => {
    let codigo = 200;
    try {
      const cuerpo = await rutas.get(clave)!({ query: {}, params: {}, headers: {}, body: null, ...req }, { code: (n: number) => { codigo = n; } }) as Record<string, unknown>;
      return { status: codigo, body: cuerpo };
    } catch (e) {
      let r: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
      errores(e as Error, null, { code: (n) => ({ send: (b) => { r = { status: n, body: b as Record<string, unknown> }; } }) });
      return r;
    }
  };
  const plan = (r: { body: Record<string, unknown> }) => r.body['plan'] as PlanHttp;

  before(async () => {
    for (const k of ['ATLAS_KARAJAN_DATA', 'ATLAS_WORKSPACE', 'ATLAS_KARAJAN_LAYOUT', 'ATLAS_DEV_API', 'ATLAS_KARAJAN_RESOURCES', 'ATLAS_LIMITES_PLAN', 'KARAJAN_LIMITES_PLAN']) entorno[k] = process.env[k];
    delete process.env['ATLAS_KARAJAN_DATA'];
    process.env['ATLAS_WORKSPACE'] = dir;
    delete process.env['ATLAS_KARAJAN_LAYOUT']; delete process.env['KARAJAN_LIMITES_PLAN'];
    process.env['ATLAS_DEV_API'] = 'http://127.0.0.1:1';
    process.env['ATLAS_LIMITES_PLAN'] = join(dir, 'limites-plan.json');
    globalThis.fetch = (async () => { throw new Error('sin Atlas dev'); }) as unknown as typeof fetch;
    mkdirSync(datos, { recursive: true });
    writeFileSync(join(datos, 'modo.json'), '{"modo":"desarrollo"}\n');
    const app = {
      get: (r: string, f: Manejador) => rutas.set(`GET ${r}`, f), post: (r: string, f: Manejador) => rutas.set(`POST ${r}`, f), put: (r: string, f: Manejador) => rutas.set(`PUT ${r}`, f),
      setErrorHandler: (f: typeof errores) => { errores = f; },
    };
    await registrar(app as never, { id: 'karajan', version: '0.12.0', datos });
  });
  after(() => {
    globalThis.fetch = fetchOriginal;
    for (const [k, v] of Object.entries(entorno)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* temporal con bases SQLite abiertas en Windows */ }
  });

  it('describe los modos y sus incompatibilidades', async () => {
    const r = await llamar('GET /planificador/modos');
    assert.deepEqual((r.body['modos'] as { id: string }[]).map((m) => m.id), ['classic', 'single-agent', 'master-slave', 'co-work', 'auto', 'lazy-agent', 'milestone', 'checker']);
    assert.equal((await llamar('POST /planificador/validar', { body: { modo: 'co-work', modificadores: ['lazy-agent'] } })).body['ok'], false);
  });

  it('plan: clasifica el prompt y construye el plan del modo pedido; con tarea lo guarda y se lee', async () => {
    const r = await llamar('POST /planificador/plan', { body: { prompt: 'Implementa un endpoint REST con pruebas y documenta la API', modo: 'master-slave', modificadores: ['checker'], tarea: 'tsk_a' } });
    assert.equal(r.status, 200);
    const p = plan(r);
    assert.equal(p.modo, 'master-slave');
    assert.equal(p.actores['principal']!.nivel, 'superior');
    assert.equal(p.pasos.at(-1)!.tipo, 'checker');
    assert.equal(r.body['guardado'], true);
    assert.ok(existsSync(join(datos, 'planificador-planes.json')));
    assert.equal((await llamar('GET /planificador/planes/:tarea', { params: { tarea: 'tsk_a' } })).body['estado'], 'planificado');
    assert.equal((await llamar('GET /planificador/planes')).body['planes'] instanceof Array, true);
  });

  it('plan: con simulacro no guarda; auto elige formato y deja la comparación', async () => {
    const r = await llamar('POST /planificador/plan', { body: { prompt: 'Refactoriza el módulo de pagos y migra la base de datos', modo: 'auto', tarea: 'tsk_b', simulacro: true } });
    const p = plan(r);
    assert.equal(r.body['guardado'], false);
    assert.notEqual(p.modo, 'auto');
    assert.equal(p.solicitado, 'auto');
    assert.ok(p.alternativas.length >= 3 && /Auto eligió/.test(p.motivo));
    assert.equal((await llamar('GET /planificador/planes/:tarea', { params: { tarea: 'tsk_b' } })).status, 404);
  });

  it('plan: una combinación imposible responde con un plan rechazado, sin pasos y con los errores', async () => {
    const r = await llamar('POST /planificador/plan', { body: { prompt: 'x tarea', modo: 'co-work', modificadores: ['lazy-agent'], tarea: 'tsk_c' } });
    assert.equal(r.status, 200);
    assert.ok(plan(r).errores.length > 0 && plan(r).pasos.length === 0);
    assert.equal(r.body['guardado'], false);
    assert.equal((await llamar('POST /planificador/plan', { body: { prompt: '  ' } })).status, 422);
  });

  it('checker y eventos: quedan en el plan; un checker fallido bloquea y un estado desconocido se rechaza', async () => {
    const ok = await llamar('POST /planificador/checker', { body: { tarea: 'tsk_a', estado: 'hallazgos', resumen: '1 bug', hallazgos: [{ severidad: 'alta', titulo: 'Falta validar el id' }] } });
    assert.equal(ok.status, 200);
    assert.equal(((ok.body['checker'] as { hallazgos: unknown[] }).hallazgos).length, 1);
    assert.equal((await llamar('POST /planificador/checker', { body: { tarea: 'tsk_a', estado: 'fallido', resumen: 'sin tokens' } })).body['estado'], 'bloqueado');
    assert.equal((await llamar('POST /planificador/checker', { body: { tarea: 'nada', estado: 'limpio' } })).status, 404);
    assert.equal((await llamar('POST /planificador/checker', { body: { tarea: 'tsk_a', estado: 'genial' } })).status, 422);
    assert.equal((await llamar('POST /planificador/evento', { body: { tarea: 'tsk_a', tipo: 'hito', detalle: 'hito 1 validado', estado: 'ejecutando' } })).body['estado'], 'ejecutando');
    assert.equal((await llamar('POST /planificador/evento', { body: { tarea: 'tsk_a', tipo: 'hito', detalle: 'x', estado: 'genial' } })).status, 422);
    assert.equal((await llamar('POST /planificador/evento', { body: { tarea: 'tsk_a', tipo: 'otro', detalle: 'x' } })).status, 422);
  });

  it('config: se lee y se cambia (en desarrollo); el cambio persiste y se normaliza', async () => {
    assert.equal(((await llamar('GET /planificador/config')).body['config'] as { jefe: { intervencionMin: number } }).jefe.intervencionMin, 5);
    const c = (await llamar('PUT /planificador/config', { body: { jefe: { intervencionMin: 7 }, maxSubagentes: 99 } })).body['config'] as { jefe: { intervencionMin: number }; maxSubagentes: number };
    assert.deepEqual([c.jefe.intervencionMin, c.maxSubagentes], [7, 8]);
    assert.equal(JSON.parse(readFileSync(join(datos, 'planificador.json'), 'utf8')).jefe.intervencionMin, 7);
    assert.equal((await llamar('PUT /planificador/config', { body: [1] })).status, 422);
  });

  it('aparece como componente de la capa Decisión con su ficha y su laboratorio', async () => {
    const r = await llamar('GET /laboratorio/arquitectura/:id', { params: { id: 'planificador' } });
    assert.equal(r.status, 200);
    assert.equal(r.body['familia'], 'decision');
    assert.deepEqual((r.body['escenarios'] as { id: string }[]).map((e) => e.id), ['contrato', 'replay']);
    assert.equal((r.body['ficha'] as { especificado: boolean }).especificado, true);
  });
});
