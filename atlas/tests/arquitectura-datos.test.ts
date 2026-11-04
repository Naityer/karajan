import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { Almacen } from '../src/almacen';
import { AtlasDev } from '../src/atlas-dev';
import { construirArquitectura, type Arquitectura, type ComponenteVista, type ContextoArquitectura } from '../src/arquitectura';
import { COMPONENTES, ENLACES, FAMILIAS } from '../src/componentes';
import { configDesde } from '../src/heuristica';
import { RegistroLab, type Ejecucion } from '../src/laboratorio';
import { Pasarela } from '../src/pasarela-borradores';
import { presetNivel } from '../src/reglas';
import { Rotador } from '../src/rotador';
import { registrar } from '../src/servidor';
import { atlasFalso } from './ayuda-atlas';

const dir = mkdtempSync(join(tmpdir(), 'karajan-arq-'));
// El servidor y los registros dejan sus SQLite abiertas: en Windows el temporal puede no borrarse.
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* bases abiertas */ } });

const BASE = Date.parse('2026-10-01T10:00:00Z');
const instante = (i: number) => new Date(BASE + i * 3_600_000).toISOString();
const fila = (componente: string, escenario: string, i: number, extra: Partial<Omit<Ejecucion, 'id'>> = {}): Omit<Ejecucion, 'id'> => ({
  componente, escenario, tipo: 'replay', version: '0.7.0', inicio: instante(i), ms: 12, muestra: 30, suficiente: true, metricas: {}, hallazgos: [], detalle: null, error: null, umbrales: null, ...extra,
});

function contexto(nombre: string) {
  const d = mkdtempSync(join(dir, `${nombre}-`));
  const atlas = atlasFalso();
  const registro = new RegistroLab(join(d, 'lab', 'laboratorio.db'));
  const almacen = new Almacen(join(d, 'task_logs.db'));
  const pasarela = new Pasarela(new AtlasDev('http://atlas', atlas.fetch), join(d, 'lab', 'borradores.json'));
  const rotador = new Rotador({ estado: join(d, 'rotador.json'), casa: join(d, 'casa'), usoAtlas: join(d, 'no-existe.json') });
  const ctx: ContextoArquitectura = {
    version: '0.7.0', modo: 'produccion', dirDatos: d, dirLab: join(d, 'lab'), config: () => configDesde(null), perfil: () => presetNivel(), rotador, limites: () => null,
    pasarela, biblioteca: { disponible: false, ruta: null }, registro, almacen, ahora: () => new Date('2026-10-24T12:00:00Z'),
  };
  return { ctx, registro, almacen, pasarela, atlas, d };
}

const todo = async (ctx: ContextoArquitectura) => (await construirArquitectura(ctx)) as Arquitectura;
const porId = (a: Arquitectura, id: string) => a.componentes.find((c) => c.id === id)!;

describe('arquitectura: contrato de datos', () => {
  const { ctx, registro, atlas } = contexto('contrato');
  let a: Arquitectura;

  before(async () => {
    // clasificador: ok · delegador: hallazgos (con un borrador abierto) · selector: error · biblioteca: sin ejecutar
    registro.guardar(fila('clasificador', 'frente-a-la-persona', 0, { metricas: { nivel_exacto: 0.7, anotadas_nivel: 25 }, umbrales: { muestra: '≥ 20' } }));
    registro.guardar(fila('delegador', 'fidelidad', 1, { tipo: 'contrato', metricas: { trazabilidad: 1, reglas_sin_uso: 2 }, detalle: { reglas: ['a'] },
      hallazgos: [{ clave: 'reglas-sin-uso', severidad: 'media', titulo: 'Dos reglas sin uso', evidencia: 'e', propuesta: 'p' }] }));
    registro.guardar(fila('delegador', 'concordancia', 2, { metricas: { concordancia: null }, suficiente: false, muestra: 3 }));
    registro.guardar(fila('selector', 'explicitas', 3, { tipo: 'contrato', error: 'no pude leer las skills', muestra: 0, suficiente: false }));
    const borrador = await new Pasarela(new AtlasDev('http://atlas', atlas.fetch), join(ctx.dirLab, 'borradores.json'))
      .proponer('delegador', { clave: 'reglas-sin-uso', severidad: 'media', titulo: 'Dos reglas sin uso', evidencia: 'e', propuesta: 'p' });
    assert.equal(borrador.accion, 'creada');
    a = await todo(ctx);
  });

  it('forma general: versión, modo, fecha, familias y enlaces', () => {
    assert.equal(a.version_contrato, 1);
    assert.equal(a.version, '0.7.0');
    assert.equal(a.modo, 'produccion');
    assert.equal(a.generado, '2026-10-24T12:00:00.000Z');
    assert.deepEqual(a.familias.map((f) => f.id), FAMILIAS.map((f) => f.id));
    assert.deepEqual(a.familias.map((f) => f.orden), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(a.familias.map((f) => f.nombre), ['Interfaz', 'Modificadores', 'Observación', 'Ejecución', 'Decisión', 'Base']);
    assert.deepEqual(a.familias.flatMap((f) => f.componentes).sort(), COMPONENTES.map((c) => c.id).sort());
    assert.deepEqual(a.enlaces, ENLACES);
    assert.deepEqual(a.familias.find((f) => f.id === 'decision')!.componentes, ['clasificador', 'delegador', 'selector', 'rotador', 'tutor', 'etiquetas']);
  });

  it('los 22 componentes traen todos los campos del contrato', () => {
    assert.equal(a.componentes.length, 24);
    for (const c of a.componentes) {
      assert.ok(['ok', 'hallazgos', 'sin_ejecutar', 'pendiente', 'error'].includes(c.estado), c.id);
      assert.ok(c.familia && c.responsabilidad && Array.isArray(c.modulos), c.id);
      assert.ok(c.ficha.resumen && Array.isArray(c.ficha.como_funciona.pasos) && Array.isArray(c.ficha.reglas) && typeof c.ficha.especificado === 'boolean', c.id);
      assert.ok(Array.isArray(c.ultimas) && Array.isArray(c.escenarios) && Array.isArray(c.hallazgos) && Array.isArray(c.avisos), c.id);
      assert.equal(typeof c.historial, 'object');
      assert.equal(typeof c.detalle, 'object');
      for (const k of ['tareas', 'runs', 'latencia_p50_ms', 'coste_total_usd', 'tokens', 'ultima_actividad', 'extra']) assert.ok(k in c.operacion, `${c.id}.operacion.${k}`);
      assert.equal(c.pendiente === null, !!COMPONENTES.find((x) => x.id === c.id)!.pendiente === false);
    }
    // Una vista serializable: sin funciones ni undefined.
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(a)));
  });

  it('estado: ok · hallazgos · sin_ejecutar · pendiente · error', () => {
    assert.equal(porId(a, 'clasificador').estado, 'ok');
    assert.equal(porId(a, 'delegador').estado, 'hallazgos');
    assert.equal(porId(a, 'selector').estado, 'error');
    assert.equal(porId(a, 'biblioteca').estado, 'sin_ejecutar');
    assert.equal(porId(a, 'rotador').estado, 'sin_ejecutar');
    for (const id of ['etiquetas', 'api']) assert.equal(porId(a, id).estado, 'pendiente', id);
    assert.equal(porId(a, 'delegador').muestra_corta, true);
    assert.equal(porId(a, 'clasificador').muestra_corta, false);
  });

  it('escenarios con su tipo, descripción y los umbrales guardados', () => {
    const c = porId(a, 'clasificador');
    assert.deepEqual(c.escenarios.map((e) => e.id), ['frente-a-la-persona']);
    assert.equal(c.escenarios[0]!.tipo, 'replay');
    assert.deepEqual(c.escenarios[0]!.umbrales, { muestra: '≥ 20' });
    assert.deepEqual(porId(a, 'delegador').escenarios.map((e) => e.id), ['fidelidad', 'concordancia', 'adecuacion', 'determinismo']);
    assert.equal(porId(a, 'delegador').escenarios[0]!.umbrales, null);
    assert.deepEqual(porId(a, 'rotador').escenarios.map((e) => e.id), ['contrato', 'historial']);
  });

  it('últimas, detalle y hallazgos con el estado de su borrador', () => {
    const d = porId(a, 'delegador');
    assert.deepEqual(d.ultimas.map((u) => u.escenario).sort(), ['concordancia', 'fidelidad']);
    const fid = d.ultimas.find((u) => u.escenario === 'fidelidad')!;
    assert.equal(fid.hallazgos, 1);
    assert.equal(fid.ms, 12);
    assert.deepEqual(d.detalle['fidelidad'], { reglas: ['a'] });
    assert.equal(d.hallazgos.length, 1);
    assert.equal(d.hallazgos[0]!.escenario, 'fidelidad');
    assert.equal(d.hallazgos[0]!.severidad, 'media');
    assert.ok(d.hallazgos[0]!.borrador?.tarea);
    assert.equal(d.hallazgos[0]!.borrador?.estado, 'borrador');
    assert.equal(porId(a, 'selector').ultimas[0]!.error, 'no pude leer las skills');
    // En la vista general, las últimas no cargan el detalle; en la de un componente, sí.
    assert.ok(!('detalle' in fid));
  });

  it('configuración presente en los cuatro componentes con laboratorio', () => {
    for (const id of ['clasificador', 'delegador', 'selector', 'biblioteca']) {
      const cfg = porId(a, id).configuracion;
      assert.ok(cfg && Object.keys(cfg).length, `${id} sin configuración`);
    }
    const sel = porId(a, 'selector').configuracion!;
    assert.equal(sel['umbral'], 15);
    assert.equal(sel['peso_explicita'], 100);
    const del = porId(a, 'delegador').configuracion!;
    assert.match(String(del['perfil']), /por-nivel/);
    assert.ok((del['agentes'] as string[]).length >= 3);
    assert.deepEqual(porId(a, 'clasificador').configuracion!['umbrales_nivel'], ['N1 ≤ 1.5', 'N2 ≤ 2.5', 'N3 ≤ 3.5', 'N4 ≤ 4.3']);
    assert.equal(porId(a, 'modo').configuracion!['modo'], 'produccion');
    assert.equal(porId(a, 'rotador').configuracion!['dias_nucleo'], 14);
  });

  it('fichas: las de los cuatro componentes con laboratorio son detalladas; las sin código, cortas y no especificadas', () => {
    for (const id of ['clasificador', 'delegador', 'selector', 'biblioteca', 'comparador']) {
      const f = porId(a, id).ficha;
      assert.equal(f.especificado, true);
      assert.ok(f.como_funciona.pasos.length >= 4 && f.como_funciona.entradas.length && f.como_funciona.salidas.length && f.reglas.length, id);
      assert.ok(f.como_funciona.pasos.every((p) => /\.ts/.test(p)), `${id}: cada paso nombra el fichero que lo implementa`);
    }
    for (const id of ['etiquetas']) assert.equal(porId(a, id).ficha.especificado, false, id);
    for (const id of ['curador', 'comparador', 'eficiencia', 'metodo', 'prompts']) assert.equal(porId(a, id).ficha.especificado, true, id);
  });

  it('operación: nula donde no hay fuente y con datos donde sí', () => {
    for (const id of ['api', 'cli', 'curador', 'comparador', 'eficiencia', 'metodo', 'prompts', 'etiquetas', 'biblioteca']) {
      const o = porId(a, id).operacion;
      assert.equal(o.tareas, null, id);
      assert.equal(o.runs, null, id);
    }
    const alm = porId(a, 'almacen').operacion;
    assert.equal(alm.tareas, 0);
    assert.equal(alm.latencia_p50_ms, null);
    assert.equal(porId(a, 'laboratorio').operacion.ultima_actividad, instante(3));
    assert.equal(porId(a, 'pasarela').operacion.tareas, 1);
    assert.equal(porId(a, 'limites').operacion.extra?.['dato_reciente'], false);
  });

  it('operación con tareas y runs reales del registro', async () => {
    const t = contexto('operacion');
    const c = { task_id: 'tsk_1', original_prompt: 'Corrige el bug de la API', created_at: '2026-10-01T09:00:00.000Z', complexity_level: 'level_3_intermediate', recommended_model: 'medium_model', complexity_score: 3, requires_human_review: false, subtasks: [{}] };
    t.almacen.guardarTarea(c, 'classified');
    t.almacen.registrarDecision({ task_id: 'tsk_1', phase: 'classify', decision: 'model=medium_model' });
    t.almacen.registrarDecision({ task_id: 'tsk_1', phase: 'assign', decision: 'sub_001->x:codex' });
    t.almacen.registrarDecision({ task_id: 'tsk_1', phase: 'delegate', decision: 'git:rama=agente/tsk_1' });
    const run = (latencia: number, coste: number) => t.almacen.registrarRun({ task_id: 'tsk_1', provider_name: 'codex', routing_entity_id: 'e', routing_entity_name_snapshot: 'Codex', model_id: 'default', backend: 'cli', status: 'completed',
      started_at: '2026-10-01T09:05:00.000Z', completed_at: '2026-10-01T09:06:00.000Z', latency_ms: latencia, input_tokens: 100, output_tokens: 20, estimated_cost_usd: coste, error: null });
    run(1000, 0.01); run(3000, 0.02); run(2000, 0.03);
    t.almacen.actualizarTarea('tsk_1', 'completed', { total_estimated_cost_usd: 0.06 });
    const v = await todo(t.ctx);
    const prov = porId(v, 'proveedores').operacion;
    assert.equal(prov.runs, 3);
    assert.equal(prov.latencia_p50_ms, 2000);
    assert.equal(prov.coste_total_usd, 0.06);
    assert.deepEqual(prov.tokens, { entrada: 300, salida: 60, total: 360 });
    assert.equal((prov.extra!['por_proveedor'] as { proveedor: string; runs: number }[])[0]!.proveedor, 'codex');
    assert.equal(porId(v, 'almacen').operacion.tareas, 1);
    assert.equal(porId(v, 'clasificador').operacion.tareas, 1);
    assert.equal(porId(v, 'delegador').operacion.tareas, 1);
    assert.equal(porId(v, 'aislamiento').operacion.tareas, 1);
    assert.equal(porId(v, 'produccion').operacion.tareas, 1);
  });
});

describe('arquitectura: historial de métricas', () => {
  const { ctx, registro } = contexto('historial');

  before(() => {
    // 40 ejecuciones insertadas desordenadas en el tiempo: el historial va de la más antigua a la más reciente.
    const orden = Array.from({ length: 40 }, (_, i) => i).sort((x, y) => ((x * 7) % 40) - ((y * 7) % 40));
    for (const i of orden) registro.guardar(fila('clasificador', 'frente-a-la-persona', i, { metricas: { nivel_exacto: i / 100, dominio: null, anotadas_nivel: i } }));
    registro.guardar(fila('clasificador', 'frente-a-la-persona', 40, { suficiente: false, metricas: { nivel_exacto: 0.5 } }));
  });

  it('últimas 30 por métrica, de más antigua a más reciente, sin los valores nulos', async () => {
    const h = porId(await todo(ctx), 'clasificador').historial;
    assert.deepEqual(Object.keys(h).sort(), ['anotadas_nivel', 'nivel_exacto']);
    const serie = h['nivel_exacto']!;
    assert.equal(serie.length, 30);
    assert.deepEqual(serie.map((p) => p.inicio), [...serie.map((p) => p.inicio)].sort());
    assert.equal(serie.at(-1)!.valor, 0.5);
    assert.equal(serie.at(-1)!.suficiente, false);
    assert.equal(serie.at(-1)!.escenario, 'frente-a-la-persona');
    assert.equal(serie[0]!.inicio, instante(11));
    assert.equal(h['anotadas_nivel']!.length, 30);
  });

  it('el detalle de un componente trae el historial completo y el detalle en cada «última»', async () => {
    const c = (await construirArquitectura(ctx, { id: 'clasificador' })) as ComponenteVista;
    assert.equal(c.historial['nivel_exacto']!.length, 41);
    assert.ok('detalle' in c.ultimas[0]!);
    assert.equal(c.estado, 'ok');
    assert.equal(await construirArquitectura(ctx, { id: 'no-existe' }), null);
  });
});

describe('arquitectura: nunca lanza', () => {
  it('una fuente rota deja su campo a null y lo anota en avisos', async () => {
    const { ctx } = contexto('roto');
    const roto: ContextoArquitectura = {
      ...ctx,
      registro: { ejecuciones: () => { throw new Error('laboratorio.db corrupta'); } },
      almacen: { ...ctx.almacen, resumenOperacion: () => { throw new Error('task_logs.db ilegible'); }, tareasPlanas: () => { throw new Error('sin tareas'); } } as ContextoArquitectura['almacen'],
      config: () => { throw new Error('config rota'); },
      pasarela: { leer: () => { throw new Error('borradores rotos'); } },
    };
    const v = await todo(roto);
    assert.equal(v.componentes.length, 24);
    const c = porId(v, 'clasificador');
    assert.equal(c.configuracion, null);
    assert.equal(c.estado, 'sin_ejecutar');
    assert.ok(c.avisos.some((x) => /laboratorio\.db corrupta/.test(x)));
    assert.ok(c.avisos.some((x) => /config rota/.test(x)));
    assert.equal(c.operacion.tareas, null);
    assert.ok(porId(v, 'almacen').avisos.some((x) => /task_logs\.db ilegible/.test(x)));
    assert.ok(porId(v, 'selector').avisos.some((x) => /sin tareas/.test(x)));
    assert.doesNotThrow(() => JSON.stringify(v));
  });
});

// ── La ruta, con el mismo servidor y el mismo Atlas de pega que usan los tests de modo ──
describe('GET /laboratorio/arquitectura', () => {
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
    await registrar(app as never, { id: 'karajan', version: '0.8.0', datos });
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
  /** Huella de todos los ficheros de datos (menos los `-shm`, que SQLite toca al abrir en WAL): contenido y fecha. */
  const huella = () => {
    const salida: Record<string, string> = {};
    const recorrer = (d: string) => {
      for (const n of readdirSync(d)) {
        const ruta = join(d, n);
        if (statSync(ruta).isDirectory()) recorrer(ruta);
        else if (!n.endsWith('-shm')) salida[ruta] = `${createHash('sha256').update(readFileSync(ruta)).digest('hex')}@${statSync(ruta).mtimeMs}`;
      }
    };
    recorrer(datos);
    return salida;
  };

  it('devuelve los 22 componentes con el contrato', async () => {
    const r = await llamar('GET /laboratorio/arquitectura');
    assert.equal(r.status, 200);
    const v = r.body as unknown as Arquitectura;
    assert.equal(v.version, '0.8.0');
    assert.equal(v.modo, 'produccion');
    assert.equal(v.componentes.length, 24);
    assert.equal(porId(v, 'delegador').estado, 'sin_ejecutar');
    assert.equal(porId(v, 'rotador').estado, 'sin_ejecutar');
    assert.ok(Object.keys(porId(v, 'delegador').configuracion!).length);
    assert.equal(v.enlaces.length, ENLACES.length);
  });

  it('GET /laboratorio/arquitectura/:id devuelve un componente y 404 si no existe', async () => {
    const ok = await llamar('GET /laboratorio/arquitectura/:id', { params: { id: 'selector' } });
    assert.equal(ok.status, 200);
    assert.equal((ok.body as unknown as ComponenteVista).id, 'selector');
    assert.equal((ok.body as unknown as ComponenteVista).familia, 'decision');
    const no = await llamar('GET /laboratorio/arquitectura/:id', { params: { id: 'no-existe' } });
    assert.equal(no.status, 404);
    assert.match(String(no.body['detail']), /no-existe/);
  });

  it('refleja una ejecución del laboratorio hecha por POST y el id de tarea en el cuerpo basta para las mutaciones', async () => {
    const ej = await llamar('POST /laboratorio/ejecutar', { body: { componente: 'clasificador', proponer: false, tarea: 'acep' } });
    assert.equal(ej.status, 200);
    const c = (await llamar('GET /laboratorio/arquitectura/:id', { params: { id: 'clasificador' } })).body as unknown as ComponenteVista;
    assert.equal(c.estado, 'ok');
    assert.equal(c.muestra_corta, true);
    assert.equal(c.ultimas.length, 1);
    assert.deepEqual(c.escenarios[0]!.umbrales && Object.keys(c.escenarios[0]!.umbrales!), ['muestra', 'nivel_exacto']);
    assert.ok(c.historial['anotadas_nivel']!.length >= 1);
    // El guardián de modo acepta la tarea en el cuerpo (el proxy de Atlas dev no reenvía la cabecera x-karajan-tarea).
    assert.equal((await llamar('POST /routing-layout/desde-texto', { body: { texto: 'Claude para lo complejo', aplicar: true } })).status, 423);
    assert.equal((await llamar('POST /routing-layout/desde-texto', { body: { texto: 'Claude para lo complejo', aplicar: true, tarea: 'acep' } })).status, 200);
  });

  it('las rutas GET no escriben nada: ni las bases, ni los JSON, ni el modo', async () => {
    await llamar('GET /laboratorio/arquitectura');
    const antes = huella();
    assert.ok(Object.keys(antes).some((f) => f.endsWith('task_logs.db')) && Object.keys(antes).some((f) => f.endsWith('laboratorio.db')));
    for (let i = 0; i < 2; i++) {
      assert.equal((await llamar('GET /laboratorio/arquitectura')).status, 200);
      for (const id of ['clasificador', 'delegador', 'selector', 'biblioteca', 'rotador', 'almacen']) assert.equal((await llamar('GET /laboratorio/arquitectura/:id', { params: { id } })).status, 200);
      assert.equal((await llamar('GET /laboratorio/arquitectura/:id', { params: { id: 'no-existe' } })).status, 404);
    }
    assert.deepEqual(huella(), antes);
  });
});
