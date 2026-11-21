import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { registrar } from '../src/servidor';
import { simularSolicitud } from '../src/dosificador-sim';
import { leerConfig } from '../src/dosificador-config';

/** Las rutas /dosificador/* del paquete, con un servidor falso y todo en un directorio temporal (ni ~/.atlas-dev ni datos reales). */
type Manejador = (req: Record<string, unknown>, reply: { code(n: number): unknown }) => unknown;
const dir = mkdtempSync(join(tmpdir(), 'karajan-dosif-api-'));
const AHORA = Date.now();
const rutas = new Map<string, Manejador>();
let errores: (e: Error, req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => unknown = () => undefined;
const entorno: Record<string, string | undefined> = {};
const fetchOriginal = globalThis.fetch;

const uso = (semanal: number) => ({ semanal, sesion: 10, reinicio: new Date(AHORA + 4 * 86_400_000).toISOString(), reinicioSesion: new Date(AHORA + 3 * 3_600_000).toISOString(), plan: 'sintetico', fuente: 'test' });
const entrada = (extra: Record<string, unknown> = {}) => ({
  ahora: AHORA, tareas: [{ id: 't1', prioridad: 'normal', creada: AHORA - 3_600_000, programada: null, agente: 'auto', clasificacion: { nivel_tarea: 'level_2_moderate', dominio: 'programming' }, repo: 'x' }],
  equipos: [{ id: 'pc', disponible: true, enCurso: { claude: 0, codex: 0 }, repos: ['x'] }],
  agentes: { claude: { disponible: true, enCurso: 0 }, codex: { disponible: true, enCurso: 0 } }, uso: { claude: uso(40), codex: uso(40) }, leido: new Date(AHORA - 60_000).toISOString(), ...extra,
});

describe('API del dosificador', () => {
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

  before(async () => {
    for (const k of ['ATLAS_KARAJAN_DATA', 'ATLAS_WORKSPACE', 'ATLAS_KARAJAN_LAYOUT', 'ATLAS_DEV_API', 'ATLAS_KARAJAN_RESOURCES', 'ATLAS_LIMITES_PLAN', 'KARAJAN_LIMITES_PLAN']) entorno[k] = process.env[k];
    delete process.env['ATLAS_KARAJAN_DATA'];
    process.env['ATLAS_WORKSPACE'] = dir;
    delete process.env['ATLAS_KARAJAN_LAYOUT']; delete process.env['KARAJAN_LIMITES_PLAN'];
    process.env['ATLAS_DEV_API'] = 'http://127.0.0.1:1';
    process.env['ATLAS_LIMITES_PLAN'] = join(dir, 'limites-plan.json');
    globalThis.fetch = (async () => { throw new Error('sin Atlas dev'); }) as unknown as typeof fetch;
    writeFileSync(process.env['ATLAS_LIMITES_PLAN'], JSON.stringify({ claude: uso(41), codex: uso(12), leido: new Date().toISOString() }));
    mkdirSync(datos, { recursive: true });
    writeFileSync(join(datos, 'modo.json'), '{"modo":"desarrollo"}\n');
    const app = {
      get: (r: string, f: Manejador) => rutas.set(`GET ${r}`, f), post: (r: string, f: Manejador) => rutas.set(`POST ${r}`, f), put: (r: string, f: Manejador) => rutas.set(`PUT ${r}`, f),
      setErrorHandler: (f: typeof errores) => { errores = f; },
    };
    await registrar(app as never, { id: 'karajan', version: '0.10.0', datos });
  });
  after(() => {
    globalThis.fetch = fetchOriginal;
    for (const [k, v] of Object.entries(entorno)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* en Windows las bases SQLite abiertas del paquete no se dejan borrar; es un temporal */ }
  });

  it('decidir devuelve el contrato y guarda su estado en dosificador-estado.json; con simulacro no lo guarda', async () => {
    const sim = await llamar('POST /dosificador/decidir', { body: { ...entrada(), simulacro: true } });
    assert.equal(sim.status, 200);
    assert.equal(existsSync(join(datos, 'dosificador-estado.json')), false);
    const r = await llamar('POST /dosificador/decidir', { body: entrada() });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['decisiones', 'diferidas', 'estado']);
    const d = (r.body['decisiones'] as { tarea: string; agente: string; equipo: string; lanzarEn: number | null; motivo: string }[]);
    assert.equal(d.length, 1);
    assert.equal(d[0]!.tarea, 't1');
    assert.equal(d[0]!.equipo, 'pc');
    assert.ok(['claude', 'codex'].includes(d[0]!.agente));
    assert.deepEqual(Object.keys(r.body['estado'] as object).sort(), ['agotamiento', 'burn', 'circuitos', 'modo']);
    assert.ok(existsSync(join(datos, 'dosificador-estado.json')));
    assert.ok(JSON.parse(readFileSync(join(datos, 'dosificador-estado.json'), 'utf8')).leases['t1']);
  });

  it('una entrada inválida da 400 con {error}, nunca 500', async () => {
    for (const malo of [null, 'x', {}, { ...entrada(), ahora: 'ya' }, { ...entrada(), tareas: [{ id: 'a', prioridad: 'urgente', creada: 1 }] }, { ...entrada(), agentes: { claude: 1 } }, { ...entrada(), leido: 'nunca' }]) {
      const r = await llamar('POST /dosificador/decidir', { body: malo });
      assert.equal(r.status, 400, JSON.stringify(malo)?.slice(0, 60));
      assert.equal(typeof r.body['error'], 'string');
    }
  });

  it('informa si no puede guardar el estado en vez de confirmar una decisión no persistida', async () => {
    const temporalBloqueado = join(datos, 'dosificador-estado.json.tmp');
    mkdirSync(temporalBloqueado);
    try {
      const r = await llamar('POST /dosificador/decidir', { body: entrada() });
      assert.equal(r.status, 503);
      assert.match(String(r.body['detail']), /No se pudo guardar el estado del dosificador/);
      assert.match(String(r.body['detail']), /permisos y el espacio disponible/);
      const sim = await llamar('POST /dosificador/decidir', { body: { ...entrada(), simulacro: true } });
      assert.equal(sim.status, 200, 'una simulación no guarda el estado');
    } finally { rmSync(temporalBloqueado, { recursive: true, force: true }); }
  });

  it('observar libera el lease, aprende el coste de la clase y, si hay límite, abre el circuito hasta resets_at', async () => {
    const mal = await llamar('POST /dosificador/observar', { body: { tarea: 't1', agente: 'gpt' } });
    assert.equal(mal.status, 400);
    assert.equal((await llamar('POST /dosificador/observar', { body: { tarea: 't1', agente: 'claude', costePct: -4 } })).status, 400);
    const d = (await llamar('POST /dosificador/decidir', { body: entrada() })).body['decisiones'] as { agente: string }[];
    const agente = d[0]!.agente;
    const ok = await llamar('POST /dosificador/observar', { body: { tarea: 't1', agente, costePct: 0.9 } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body['clase'], `2|programming|${agente}`, 'la clase sale del lease');
    assert.equal(ok.body['aprendido'], true);
    assert.equal((ok.body['estimacion'] as { n: number }).n, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(datos, 'dosificador-estado.json'), 'utf8')).leases, {});
    const resets = Date.now() + 2 * 3_600_000;
    const lim = await llamar('POST /dosificador/observar', { body: { tarea: 't2', agente, limiteAlcanzado: { resetsAt: new Date(resets).toISOString() } } });
    assert.equal(lim.body['circuito_hasta'], new Date(resets).toISOString(), 'abierto hasta resets_at');
  });

  it('con el circuito de un agente abierto, decidir no lo usa y el estado lo cuenta', async () => {
    const e = (await llamar('GET /dosificador/estado')).body;
    const abierto = Object.entries(e['circuitos'] as Record<string, boolean>).filter(([, v]) => v).map(([k]) => k);
    assert.equal(abierto.length, 1);
    const ahora = Date.now();
    const r = await llamar('POST /dosificador/decidir', { body: { ...entrada({ ahora, leido: new Date(ahora).toISOString() }), simulacro: true } });
    const decisiones = r.body['decisiones'] as { agente: string }[];
    assert.ok(decisiones.every((x) => x.agente !== abierto[0]));
    assert.equal(decisiones.length, 1);
  });

  it('estado: cuota por agente, modo, burn, agotamiento, circuitos y tareas en vuelo (solo lectura)', async () => {
    const antes = readFileSync(join(datos, 'dosificador-estado.json'), 'utf8');
    const r = await llamar('GET /dosificador/estado');
    assert.equal(r.status, 200);
    for (const k of ['ahora', 'modo', 'burn', 'agotamiento', 'circuitos', 'agentes', 'cuota', 'ultima_decision', 'en_vuelo', 'clases_aprendidas', 'simulacion']) assert.ok(k in r.body, k);
    const ag = r.body['agentes'] as Record<string, { usadoPct: number | null; datos: string; techoPct: number | null }>;
    assert.equal(ag['claude']!.usadoPct, 41);
    assert.equal(ag['codex']!.usadoPct, 12);
    assert.equal(ag['claude']!.datos, 'ok');
    assert.ok(ag['claude']!.techoPct! > 0);
    assert.equal(readFileSync(join(datos, 'dosificador-estado.json'), 'utf8'), antes, 'GET no escribe');
  });

  it('config: GET da la configuración y el fichero; PUT la mezcla y la valida (en desarrollo)', async () => {
    const g = await llamar('GET /dosificador/config');
    assert.equal((g.body['config'] as { margenSeguridadPct: number }).margenSeguridadPct, 10);
    assert.equal(g.body['fichero'], join(datos, 'dosificador.json'));
    const p = await llamar('PUT /dosificador/config', { body: { margenSeguridadPct: 14, pacing: { kp: 2 }, tarea: 'x' } });
    assert.equal(p.status, 200);
    const c = p.body['config'] as { margenSeguridadPct: number; pacing: { kp: number; maxRafagaPct: number } };
    assert.deepEqual([c.margenSeguridadPct, c.pacing.kp, c.pacing.maxRafagaPct], [14, 2, 8]);
    assert.equal(JSON.parse(readFileSync(join(datos, 'dosificador.json'), 'utf8')).margenSeguridadPct, 14);
    assert.equal((await llamar('PUT /dosificador/config', { body: { margenSeguridadPct: 999 } })).status, 200);
    assert.equal(JSON.parse(readFileSync(join(datos, 'dosificador.json'), 'utf8')).margenSeguridadPct, 100, 'se recorta, no se rechaza');
    assert.equal((await llamar('PUT /dosificador/config', { body: [] })).status, 422);
    await llamar('PUT /dosificador/config', { body: { margenSeguridadPct: 10 } });
  });

  it('en producción, PUT /dosificador/config exige tarea aceptada (423) y no cambia nada', async () => {
    writeFileSync(join(datos, 'modo.json'), '{"modo":"produccion"}\n');
    const antes = readFileSync(join(datos, 'dosificador.json'), 'utf8');
    const r = await llamar('PUT /dosificador/config', { body: { margenSeguridadPct: 30 } });
    assert.equal(r.status, 423);
    assert.equal(readFileSync(join(datos, 'dosificador.json'), 'utf8'), antes);
    // decidir y observar siguen libres: solo deciden y aprenden
    assert.equal((await llamar('POST /dosificador/decidir', { body: { ...entrada(), simulacro: true } })).status, 200);
    writeFileSync(join(datos, 'modo.json'), '{"modo":"desarrollo"}\n');
  });

  it('simular corre semanas sintéticas con la configuración viva y acota los parámetros', async () => {
    const r = await llamar('POST /dosificador/simular', { body: { semanas: 1, semilla: 3 } });
    assert.equal(r.status, 200);
    assert.equal(r.body['semanas'], 1);
    assert.equal(r.body['agenteSemanas'], 2);
    assert.deepEqual(r.body, simularSolicitud(leerConfig(join(datos, 'dosificador.json')), { semanas: 1, semilla: 3 }));
    assert.equal((await llamar('POST /dosificador/simular', { body: { semanas: 500 } })).body['semanas'], 12);
  });

  it('relevo: decide, lo anota en el registro (salvo simulacro) y una entrada inválida da 400', async () => {
    const cuerpo = {
      ahora: AHORA, leido: new Date(AHORA - 60_000).toISOString(), agentes: { claude: { disponible: true, enCurso: 0 }, codex: { disponible: true, enCurso: 0 } }, uso: { claude: uso(40), codex: uso(40) },
      relevo: { id: 'rel1', equipo: 'pc', origen: 'portatil', estadoOrigen: 'bloqueada', agente: 'auto', ultimoLatido: AHORA - 7_200_000, resetsAt: AHORA - 600_000, checkpoint: true },
    };
    const antes = ((await llamar('GET /dosificador/decisiones')).body['relevos'] as unknown[]).length;
    const sim = await llamar('POST /dosificador/relevo', { body: { ...cuerpo, simulacro: true } });
    assert.equal(sim.status, 200);
    assert.equal(sim.body['accion'], 'tomar', String(sim.body['motivo']));
    assert.equal(((await llamar('GET /dosificador/decisiones')).body['relevos'] as unknown[]).length, antes, 'el simulacro no se anota');
    const r = await llamar('POST /dosificador/relevo', { body: cuerpo });
    assert.equal(typeof r.body['agente'], 'string', 'con agente auto elige uno con el circuito cerrado (el test anterior dejó abierto uno)');
    const d = (await llamar('GET /dosificador/decisiones')).body as { relevos: { relevo: string; accion: string; en: string }[]; relevo: { politicaDefecto: string }; topes: Record<string, unknown> };
    assert.equal(d.relevos[0]!.relevo, 'rel1');
    assert.equal(d.relevos[0]!.accion, 'tomar');
    assert.match(d.relevos[0]!.en, /^\d{4}-/);
    assert.equal(d.relevo.politicaDefecto, 'primero-vivo');
    assert.ok('claude' in d.topes && 'codex' in d.topes);
    assert.equal((await llamar('POST /dosificador/relevo', { body: { ...cuerpo, relevo: { id: 'x' } } })).status, 400);
  });

  it('el laboratorio del dosificador corre por la ruta de siempre y su ficha sale en la arquitectura', async () => {
    const ej = await llamar('POST /laboratorio/ejecutar', { body: { componente: 'dosificador', proponer: false, escenario: 'contrato' } });
    assert.equal(ej.status, 200);
    const informe = (ej.body['informes'] as { escenarios: { escenario: string; hallazgos: unknown[]; metricas: Record<string, number> }[] }[])[0]!.escenarios[0]!;
    assert.equal(informe.escenario, 'contrato');
    assert.deepEqual(informe.hallazgos, []);
    assert.equal(informe.metricas['parsers_fieles'], 1);
    const a = (await llamar('GET /laboratorio/arquitectura/:id', { params: { id: 'dosificador' } })).body as { familia: string; configuracion: Record<string, unknown>; operacion: { extra: Record<string, unknown> | null } };
    assert.equal(a.familia, 'decision');
    assert.equal(a.configuracion['margen_seguridad_pct'], 10);
    assert.ok(a.operacion.extra && 'tareas_en_vuelo' in a.operacion.extra);
  });
});
