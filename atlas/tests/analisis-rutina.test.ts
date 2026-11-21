import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { destilar, validarAcciones, valoresPendientes } from '../src/analisis/destilacion';
import { estadoHistorico, exportarMuestras, necesita, procesarPendientes, type Fuentes, type OpcionesProceso } from '../src/analisis/rutina';
import { Repositorio, type EventoBitacora } from '../src/analisis/repositorio';
import { VERSION_ANALISIS, type FicheroAnalisis } from '../src/analisis/tipos';
import { cadena, falso, OK, OPC } from './ayuda-analisis';

let raiz: string, dir: string;
beforeEach(() => { raiz = mkdtempSync(join(tmpdir(), 'analisis-')); dir = join(raiz, 'registros'); });
afterEach(() => rmSync(raiz, { recursive: true, force: true }));

function tarea(id: string, slug: string, extra: Record<string, unknown> = {}, hoja: Record<string, unknown> = { agente: 'claude', revisada: true }) {
  const carpeta = join(dir, 'validadas', `${id}_${slug}`);
  mkdirSync(carpeta, { recursive: true });
  writeFileSync(join(carpeta, 'tarea.json'), JSON.stringify({ version: 1, motivo: 'validada', tarea: { id, titulo: `Tarea ${slug}`, tipo: 'tarea', estado: 'completada', prompt: `Haz ${slug}`, ...extra }, hoja, cabecera: null, eventos: [{}], informe: 'ok' }), 'utf8');
  writeFileSync(join(carpeta, 'transcript.jsonl'), 'secreto\n', 'utf8');
  return carpeta;
}
const JSON_OK = '{"nivel":"simple","dominio":"backend","tipo":"feature","confianza":0.9,"razon":"api nueva"}';
const op = (extra: Partial<OpcionesProceso> = {}, eventos: EventoBitacora[] = []): OpcionesProceso => ({ limite: 20, forzar: false, maxIntentos: 3, ahora: () => new Date('2026-11-20T10:00:00Z'), bitacora: (e) => eventos.push(e), ...extra });
const fuentes = (extra: Partial<Fuentes> = {}): Fuentes => ({ repo: new Repositorio(dir), ...extra });
const leer = (carpeta: string) => JSON.parse(readFileSync(join(carpeta, 'analisis.json'), 'utf8')) as FicheroAnalisis;

describe('rutina: flujo completo con dependencias simuladas', () => {
  it('clasifica una tarea y deja etiquetas, métricas, resultado y procedencia junto a su registro', async () => {
    const carpeta = tarea('aa11', 'api', { metricas: JSON.stringify({ vueltas: [{ modelo: 'm', tokens: { in: 1, out: 2, cache: 0 }, costeUsd: 0.5, duracionMs: 900 }], porEstado: { ejecutando: 900 } }) });
    const { backend } = falso({ ollama: OK }, { ollama: JSON_OK });
    const inf = await procesarPendientes(fuentes(), cadena(backend), op());
    assert.deepEqual(inf.contadores, { analizada: 1, omitida: 0, pendiente: 0, fallida: 0, agotada: 0 });
    const f = leer(carpeta);
    assert.equal(f.proceso.estado, 'ok'); assert.equal(f.tarea_id, 'aa11');
    const a = f.actual!;
    assert.equal(a.observado.resultado, 'validada'); assert.equal(a.observado.coste_usd, 0.5); assert.equal(a.observado.duracion_activa_ms, 900);
    assert.deepEqual(a.inferido.etiquetas.map((e) => [e.eje, e.valor, e.fuente]), [['nivel', 'simple', 'modelo'], ['dominio', 'backend', 'modelo'], ['tipo', 'feature', 'modelo']]);
    assert.deepEqual([a.procedencia.version_analisis, a.procedencia.proveedor, a.procedencia.modelo], [VERSION_ANALISIS, 'ollama', 'qwen2.5:14b']);
    assert.equal(a.procedencia.fecha, '2026-11-20T10:00:00.000Z');
    // Lo observado y lo inferido están separados, y no se tocó ni se copió nada del registro.
    assert.ok(a.observado && a.inferido && !('etiquetas' in a.observado));
    assert.equal(readFileSync(join(carpeta, 'transcript.jsonl'), 'utf8'), 'secreto\n');
    assert.ok(!JSON.stringify(f).includes('secreto'));
  });

  it('también procesa tareas de la cola que aún no están en el registro, y solo las terminadas', async () => {
    tarea('aa11', 'api');
    const cola = async () => [
      { id: 'aa11', titulo: 'duplicada del registro', estado: 'completada', prompt: 'x' },
      { id: 'cc33', titulo: 'Corregir un fallo', estado: 'fallida', prompt: 'falla', tipo: 'incidencia' },
      { id: 'dd44', titulo: 'En marcha', estado: 'ejecutando', prompt: 'x' },
    ];
    const { backend } = falso({ ollama: OK }, { ollama: JSON_OK });
    const inf = await procesarPendientes(fuentes({ cola }), cadena(backend), op());
    assert.equal(inf.contadores.analizada, 2); assert.equal(inf.fuentes.cola!.tareas, 1);
    const f = leer(join(dir, 'sin-registro', 'cc33'));
    assert.equal(f.actual!.observado.resultado, 'fallida'); assert.equal(f.actual!.observado.origen, 'cola');
    assert.equal(f.actual!.inferido.etiquetas.find((e) => e.eje === 'tipo')!.valor, 'bug');
    assert.ok(!existsSync(join(dir, 'sin-registro', 'dd44')));
  });
});

describe('rutina: idempotencia y versiones', () => {
  it('procesar de nuevo la misma tarea no la duplica ni vuelve a llamar al modelo', async () => {
    const carpeta = tarea('aa11', 'api');
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    await procesarPendientes(fuentes(), cadena(m.backend), op());
    const antes = readFileSync(join(carpeta, 'analisis.json'), 'utf8');
    const inf = await procesarPendientes(fuentes(), cadena(m.backend), op({ ahora: () => new Date('2027-01-01T00:00:00Z') }));
    assert.deepEqual(inf.contadores, { analizada: 0, omitida: 1, pendiente: 0, fallida: 0, agotada: 0 });
    assert.equal(m.llamadas.length, 1); assert.equal(readFileSync(join(carpeta, 'analisis.json'), 'utf8'), antes);
    assert.ok(!existsSync(join(dir, 'sin-registro')));
  });

  it('forzar sustituye el análisis de la misma versión sin duplicarlo en el historial', async () => {
    const carpeta = tarea('aa11', 'api');
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    await procesarPendientes(fuentes(), cadena(m.backend), op());
    await procesarPendientes(fuentes(), cadena(m.backend), op({ forzar: true }));
    const f = leer(carpeta);
    assert.equal(m.llamadas.length, 2); assert.deepEqual(f.historial, []); assert.equal(f.actual!.procedencia.version_analisis, VERSION_ANALISIS);
  });

  it('una versión de análisis anterior pasa al historial y se reconoce que hay que rehacerla', async () => {
    const carpeta = tarea('aa11', 'api');
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    await procesarPendientes(fuentes(), cadena(m.backend), op());
    const f = leer(carpeta);
    f.actual!.procedencia.version_analisis = VERSION_ANALISIS - 1; // lo que dejó una versión anterior
    writeFileSync(join(carpeta, 'analisis.json'), JSON.stringify(f), 'utf8');
    assert.equal(necesita(leer(carpeta), f.actual!.procedencia.huella_origen, false, 3), 'procesar');
    await procesarPendientes(fuentes(), cadena(m.backend), op());
    const g = leer(carpeta);
    assert.equal(g.actual!.procedencia.version_analisis, VERSION_ANALISIS);
    assert.deepEqual(g.historial.map((h) => h.procedencia.version_analisis), [VERSION_ANALISIS - 1]);
  });

  it('si cambia el contenido de origen (se rechaza la validación) el análisis se rehace', async () => {
    const carpeta = tarea('aa11', 'api');
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    await procesarPendientes(fuentes(), cadena(m.backend), op());
    tarea('aa11', 'api', {}, { agente: 'claude', revisada: false });
    const inf = await procesarPendientes(fuentes(), cadena(m.backend), op());
    assert.equal(inf.contadores.analizada, 1); assert.equal(leer(carpeta).actual!.observado.validada, false);
  });

  it('el límite por ejecución reparte el trabajo y lo que queda se hace en la siguiente pasada', async () => {
    for (const id of ['a001', 'a002', 'a003']) tarea(id, id);
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    const p1 = await procesarPendientes(fuentes(), cadena(m.backend), op({ limite: 2 }));
    assert.equal(p1.contadores.analizada, 2);
    const p2 = await procesarPendientes(fuentes(), cadena(m.backend), op({ limite: 2 }));
    assert.deepEqual([p2.contadores.analizada, p2.contadores.omitida], [1, 2]);
  });
});

describe('rutina: fallos sin perder el estado', () => {
  it('sin modelo disponible la tarea queda pendiente y se completa cuando vuelve', async () => {
    const carpeta = tarea('aa11', 'api'), eventos: EventoBitacora[] = [];
    const caido = falso({ ollama: { ok: false, motivo: 'ollama no responde' } }, {});
    const p1 = await procesarPendientes(fuentes(), cadena(caido.backend), op({}, eventos));
    assert.equal(p1.contadores.pendiente, 1);
    const f = leer(carpeta);
    assert.deepEqual([f.proceso.estado, f.proceso.intentos, f.actual], ['pendiente', 0, null]); assert.match(f.proceso.error!, /ollama no responde/);
    assert.ok(eventos.some((e) => e.evento === 'sin-modelo' && e.tarea === 'aa11'));
    const vivo = falso({ ollama: OK }, { ollama: JSON_OK });
    assert.equal((await procesarPendientes(fuentes(), cadena(vivo.backend), op())).contadores.analizada, 1);
    assert.equal(leer(carpeta).proceso.estado, 'ok');
  });

  it('un modelo que falla cuenta intentos, conserva el análisis previo y al agotarlos deja de reintentar', async () => {
    const carpeta = tarea('aa11', 'api');
    const bueno = falso({ ollama: OK }, { ollama: JSON_OK });
    await procesarPendientes(fuentes(), cadena(bueno.backend), op());
    const previo = leer(carpeta).actual;
    tarea('aa11', 'api', {}, { agente: 'claude', revisada: false }); // fuerza un nuevo análisis
    const malo = falso({ ollama: OK }, { ollama: 'basura' });
    for (let i = 1; i <= 3; i++) {
      const inf = await procesarPendientes(fuentes(), cadena(malo.backend), op({ maxIntentos: 3 }));
      assert.equal(inf.contadores.fallida, 1, `intento ${i}`);
      assert.equal(leer(carpeta).proceso.intentos, i);
    }
    assert.deepEqual(leer(carpeta).actual, previo, 'el análisis anterior sigue ahí');
    const inf = await procesarPendientes(fuentes(), cadena(malo.backend), op({ maxIntentos: 3 }));
    assert.equal(inf.contadores.agotada, 1); assert.equal(malo.llamadas.length, 3);
    const forzado = await procesarPendientes(fuentes(), cadena(bueno.backend), op({ maxIntentos: 3, forzar: true }));
    assert.equal(forzado.contadores.analizada, 1); assert.equal(leer(carpeta).proceso.intentos, 0);
  });

  it('un fallo de la cola se registra y el registro se procesa igualmente', async () => {
    tarea('aa11', 'api'); const eventos: EventoBitacora[] = [];
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    const inf = await procesarPendientes(fuentes({ cola: async () => { throw new Error('Atlas dev respondió 503'); } }), cadena(m.backend), op({}, eventos));
    assert.equal(inf.contadores.analizada, 1); assert.deepEqual([inf.fuentes.cola!.ok, inf.fuentes.cola!.error], [false, 'Atlas dev respondió 503']);
    assert.ok(eventos.some((e) => e.evento === 'cola-inaccesible'));
  });

  it('un registro inaccesible se anota sin lanzar y permite reintentar luego', async () => {
    const eventos: EventoBitacora[] = [];
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    const inf = await procesarPendientes(fuentes(), cadena(m.backend), op({}, eventos));
    assert.equal(inf.fuentes.registro.ok, false); assert.match(inf.fuentes.registro.error!, /no existe el registro/);
    assert.ok(eventos.some((e) => e.evento === 'registro-inaccesible'));
    tarea('aa11', 'api');
    assert.equal((await procesarPendientes(fuentes(), cadena(m.backend), op())).contadores.analizada, 1);
  });

  it('un tarea.json corrupto no detiene a las demás', async () => {
    tarea('aa11', 'api');
    const mala = join(dir, 'validadas', 'bb22_rota'); mkdirSync(mala, { recursive: true }); writeFileSync(join(mala, 'tarea.json'), '{no es json', 'utf8');
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    const inf = await procesarPendientes(fuentes(), cadena(m.backend), op());
    assert.deepEqual([inf.contadores.analizada, inf.contadores.fallida], [1, 1]);
    assert.ok(inf.detalle.some((d) => d.id === 'bb22' && /ilegible/.test(d.error ?? '')));
  });

  it('si no se puede escribir el análisis no se pierde nada y se informa', async () => {
    const carpeta = tarea('aa11', 'api'); const eventos: EventoBitacora[] = [];
    mkdirSync(join(carpeta, 'analisis.json.tmp'), { recursive: true }); // el temporal no se puede crear: es una carpeta
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    const inf = await procesarPendientes(fuentes(), cadena(m.backend), op({}, eventos));
    assert.equal(inf.contadores.fallida, 1); assert.ok(eventos.some((e) => e.evento === 'escritura-fallida'));
    assert.ok(!existsSync(join(carpeta, 'analisis.json')));
  });
});

describe('histórico y datos para dpw7', () => {
  it('resume el estado y exporta muestras con null donde no hay dato', async () => {
    tarea('aa11', 'api', { metricas: { vueltas: [{ tokens: { in: 1, out: 1, cache: 0 }, costeUsd: 2, duracionMs: 5 }] } });
    tarea('bb22', 'fallo', { estado: 'fallida' }, { agente: 'codex' });
    const m = falso({ ollama: OK }, { ollama: JSON_OK });
    await procesarPendientes(fuentes(), cadena(m.backend), op());
    const e = estadoHistorico(new Repositorio(dir));
    assert.deepEqual([e.total, e.por_estado, e.por_version], [2, { ok: 2 }, { [VERSION_ANALISIS]: 2 }]);
    const x = exportarMuestras(new Repositorio(dir)).sort((p, q) => p.tarea.localeCompare(q.tarea));
    assert.deepEqual([x[0]!.ok, x[0]!.perfil, x[0]!.coste_usd, x[0]!.nivel], [true, null, 2, 'simple']);
    assert.deepEqual([x[1]!.ok, x[1]!.coste_usd, x[1]!.agente], [false, null, 'codex']);
  });
});

describe('destilación', () => {
  const sembrar = async () => {
    for (let i = 0; i < 4; i++) tarea(`t00${i}`, `t${i}`);
    const m = falso({ ollama: OK }, { ollama: '{"nivel":"media-alta","dominio":"programming","tipo":"feature"}' });
    await procesarPendientes(fuentes(), cadena(m.backend), op());
  };
  const cfg = { activa: true, proveedor: 'claude-cli' as const, modelo: 'opus', minimoValores: 4 };

  it('junta los valores sin normalizar con su frecuencia', async () => {
    await sembrar();
    const p = valoresPendientes(new Repositorio(dir));
    assert.deepEqual(p.map((v) => [v.eje, v.original, v.veces]).sort(), [['dominio', 'programming', 4], ['nivel', 'media-alta', 4]]);
  });
  it('está apagada por defecto y no llama a ningún modelo mientras tanto', async () => {
    await sembrar();
    const m = falso({ 'claude-cli': OK }, {});
    const r = await destilar(new Repositorio(dir), { ...cfg, activa: false }, OPC, m.backend);
    assert.deepEqual([r.acciones, m.llamadas], [[], []]); assert.match(r.motivo!, /desactivada/);
  });
  it('no propone nada si hay poca evidencia', async () => {
    await sembrar();
    const m = falso({ 'claude-cli': OK }, {});
    const r = await destilar(new Repositorio(dir), { ...cfg, minimoValores: 100 }, OPC, m.backend);
    assert.match(r.motivo!, /mínimo 100/); assert.deepEqual(m.llamadas, []);
  });
  it('propone alias y términos nuevos, descartando lo inventado o duplicado, sin tocar la taxonomía', async () => {
    await sembrar();
    const respuesta = JSON.stringify({ acciones: [
      { eje: 'nivel', original: 'media-alta', accion: 'alias', termino: 'compleja', razon: 'entre moderada y compleja' },
      { eje: 'dominio', original: 'programming', accion: 'nuevo_termino', termino: 'moderada', definicion: 'x' },
      { eje: 'dominio', original: 'programming', accion: 'alias', termino: 'inventado' },
      { eje: 'dominio', original: 'inexistente', accion: 'ignorar' },
    ] });
    const m = falso({ 'claude-cli': OK }, { 'claude-cli': respuesta });
    const r = await destilar(new Repositorio(dir), cfg, OPC, m.backend);
    assert.deepEqual(r.acciones.map((a) => [a.eje, a.original, a.accion]), [['nivel', 'media-alta', 'alias'], ['dominio', 'programming', 'nuevo_termino']]);
    assert.equal(r.proveedor, 'claude-cli');
  });
  it('un término nuevo no puede repetir uno existente', () => {
    const pend = [{ eje: 'tipo' as const, original: 'pregunta', veces: 3, ejemplos: [] }];
    assert.deepEqual(validarAcciones('{"acciones":[{"eje":"tipo","original":"pregunta","accion":"nuevo_termino","termino":"bug","definicion":"d"}]}', pend), []);
    assert.equal(validarAcciones('no', pend), null);
  });
});
