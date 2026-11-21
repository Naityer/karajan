import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clasificar, parsearRespuesta, reglas } from '../src/analisis/clasificador';
import { configDesde } from '../src/analisis/config';
import { entradaDeRegistro, huellaOrigen, observadoDe } from '../src/analisis/observado';
import { normalizar, TAXONOMIA, terminosDe } from '../src/analisis/taxonomia';
import { cadena, falso, OK, OPC } from './ayuda-analisis';

const registro = (extra: Record<string, unknown> = {}, tarea: Record<string, unknown> = {}) => ({
  version: 1, motivo: 'validada', tarea: { id: 'ab12', titulo: 'Arreglar el login', tipo: 'tarea', estado: 'completada', prompt: 'El botón de login no responde', ...tarea }, hoja: { agente: 'claude', modelo: 'sonnet', revisada: true }, cabecera: null, eventos: [{}, {}], informe: 'Corregido', ...extra,
});
const entrada = (extra?: Record<string, unknown>, tarea?: Record<string, unknown>) => entradaDeRegistro(registro(extra, tarea))!;

describe('taxonomía: normalización', () => {
  it('lleva sinónimos y escalas distintas al mismo término', () => {
    for (const v of ['media', 'Moderate', 'level_3_moderate', 'level_3', 3, 'moderada']) assert.equal(normalizar('nivel', v).valor, 'moderada', String(v));
    assert.equal(normalizar('nivel', 'level_5_critical').valor, 'critica');
    assert.equal(normalizar('nivel', 'simple').valor, 'simple');
    for (const v of ['Seguridad', 'security', 'secops']) assert.equal(normalizar('dominio', v).valor, 'seguridad');
    assert.equal(normalizar('dominio', 'documentación').valor, 'docs');
    assert.equal(normalizar('tipo', 'Fix').valor, 'bug');
  });
  it('conserva el original cuando era un alias y no lo inventa cuando es canónico', () => {
    assert.deepEqual(normalizar('nivel', 'media'), { valor: 'moderada', estado: 'canonico', original: 'media' });
    assert.deepEqual(normalizar('nivel', 'moderada'), { valor: 'moderada', estado: 'canonico', original: null });
  });
  it('los genéricos son ambiguos y lo que no está es desconocido, sin adivinar', () => {
    assert.deepEqual(normalizar('dominio', 'programming'), { valor: null, estado: 'ambiguo', original: 'programming' });
    assert.equal(normalizar('dominio', 'otros').estado, 'ambiguo');
    assert.deepEqual(normalizar('dominio', 'cocina'), { valor: null, estado: 'desconocido', original: 'cocina' });
    for (const v of [undefined, null, {}, [], '']) assert.deepEqual(normalizar('tipo', v), { valor: null, estado: 'desconocido', original: null });
  });
  it('la taxonomía no tiene alias duplicados ni términos en dos ejes con el mismo alias a distinto destino', () => {
    for (const e of TAXONOMIA) {
      const vistos = new Map<string, string>();
      for (const t of e.terminos) for (const a of [t.id, ...t.alias]) {
        const k = a.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
        assert.ok(!vistos.has(k) || vistos.get(k) === t.id, `${e.eje}: «${a}» está en ${vistos.get(k)} y en ${t.id}`);
        vistos.set(k, t.id);
        assert.ok(!e.ambiguos.includes(k), `${e.eje}: «${a}» es alias y a la vez ambiguo`);
      }
    }
    assert.deepEqual(terminosDe('nivel'), ['trivial', 'simple', 'moderada', 'compleja', 'critica']);
  });
});

describe('datos observados', () => {
  it('lee el registro real: métricas serializadas, coste, tiempo de trabajo y validación', () => {
    const metricas = JSON.stringify({ vueltas: [{ modelo: 'claude-sonnet-5-5', tokens: { in: 10, out: 20, cache: 5 }, costeUsd: 1.5, turnos: 3, duracionMs: 1000 }, { modelo: 'claude-sonnet-5-5', tokens: { in: 1, out: 2, cache: 0 }, costeUsd: 0.25, turnos: 1, duracionMs: 500 }], porEstado: { borrador: 731000000, ejecutando: 2000 } });
    const o = observadoDe(entrada({}, { metricas }));
    assert.equal(o.resultado, 'validada'); assert.equal(o.validada, true);
    assert.equal(o.coste_usd, 1.75); assert.deepEqual(o.tokens, { in: 11, out: 22, cache: 5 });
    assert.equal(o.duracion_activa_ms, 2000, 'el tiempo en borrador no es trabajo');
    assert.equal(o.vueltas, 2); assert.equal(o.agente, 'claude'); assert.equal(o.perfil, null);
  });
  it('lo que no hay se queda en null: coste de Codex y tareas sin métricas', () => {
    const sin = observadoDe(entrada());
    assert.equal(sin.coste_usd, null); assert.equal(sin.tokens, null); assert.equal(sin.duracion_activa_ms, null); assert.equal(sin.vueltas, null);
    const codex = observadoDe(entrada({}, { metricas: { vueltas: [{ tokens: { in: 1, out: 1, cache: 0 }, costeUsd: null, duracionMs: 10 }] } }));
    assert.equal(codex.coste_usd, null); assert.equal(codex.duracion_activa_ms, 10);
  });
  it('el resultado distingue completada sin validar, fallida y descartada', () => {
    assert.equal(observadoDe(entrada({ hoja: {} })).resultado, 'completada_sin_validar');
    assert.equal(observadoDe(entrada({}, { estado: 'fallida' })).resultado, 'fallida');
    assert.equal(observadoDe(entrada({}, { estado: 'descartada' })).resultado, 'descartada');
  });
  it('la huella cambia si cambia lo que se lee (p. ej. se valida) y no si no', () => {
    assert.equal(huellaOrigen(entrada()), huellaOrigen(entrada()));
    assert.notEqual(huellaOrigen(entrada()), huellaOrigen(entrada({ hoja: { revisada: false } })));
  });
  it('un registro sin id no es una tarea', () => { assert.equal(entradaDeRegistro({ tarea: {} }), null); assert.equal(entradaDeRegistro(null), null); });
});

describe('clasificación', () => {
  it('las reglas bastan cuando la hoja ya trae la clasificación: no se llama a ningún modelo', async () => {
    const { backend, llamadas } = falso({ ollama: OK }, {});
    const e = entrada({ hoja: { revisada: true, clasificacion: { nivel: ['level_2_moderate'], dominio: ['security', 'qa'], tipo: ['fix'] } } });
    const r = await clasificar(e, observadoDe(e), cadena(backend));
    assert.equal(r.estado, 'ok'); assert.equal(r.proveedor, 'reglas'); assert.deepEqual(llamadas, []);
    assert.deepEqual(r.etiquetas.map((x) => [x.eje, x.valor, x.fuente]), [['nivel', 'moderada', 'regla'], ['dominio', 'seguridad', 'regla'], ['tipo', 'bug', 'regla']]);
  });
  it('sin dato en la hoja marca desconocido y lo del tipo de la cola es regla', () => {
    const e = entrada({}, { tipo: 'incidencia' });
    const r = reglas(e, observadoDe(e));
    assert.equal(r.find((x) => x.eje === 'nivel')!.estado, 'desconocido');
    assert.equal(r.find((x) => x.eje === 'tipo')!.valor, 'bug');
  });
  it('el modelo rellena los ejes que faltan y lo fuera de taxonomía queda desconocido con su original', async () => {
    const { backend, llamadas } = falso({ ollama: OK }, { ollama: 'Claro:\n```json\n{"nivel":"media","dominio":"cocina","tipo":"bug","confianza":0.8,"razon":"login roto"}\n```' });
    const e = entrada();
    const r = await clasificar(e, observadoDe(e), cadena(backend));
    assert.deepEqual(llamadas, ['ollama']);
    assert.equal(r.proveedor, 'ollama'); assert.equal(r.modelo, 'qwen2.5:14b'); assert.ok(r.prompt_hash);
    const por = Object.fromEntries(r.etiquetas.map((x) => [x.eje, x]));
    assert.equal(por['nivel']!.valor, 'moderada'); assert.equal(por['nivel']!.fuente, 'modelo'); assert.equal(por['nivel']!.confianza, 0.8);
    assert.deepEqual([por['dominio']!.valor, por['dominio']!.estado, por['dominio']!.original, por['dominio']!.confianza], [null, 'desconocido', 'cocina', null]);
    assert.equal(por['tipo']!.valor, 'bug');
  });
  it('si Ollama no está o responde basura, prueba con Gemini y lo anota', async () => {
    const { backend, llamadas } = falso({ ollama: OK, agy: OK }, { ollama: 'no sé qué decirte', agy: '{"nivel":"simple","dominio":"frontend","tipo":"mejora"}' });
    const e = entrada();
    const r = await clasificar(e, observadoDe(e), cadena(backend));
    assert.deepEqual(llamadas, ['ollama', 'agy']); assert.equal(r.proveedor, 'agy');
    assert.deepEqual(r.intentos.map((i) => [i.proveedor, i.resultado]), [['ollama', 'error'], ['agy', 'usado']]);
  });
  it('Gemini no se usa si no está permitido ni pasado el tope por ejecución', async () => {
    const e = entrada();
    const a = falso({ agy: OK }, { agy: '{"nivel":"simple"}' });
    const r1 = await clasificar(e, observadoDe(e), cadena(a.backend, { ...OPC, permitirGemini: false }));
    assert.equal(r1.estado, 'pendiente'); assert.deepEqual(a.llamadas, []);
    const b = falso({ agy: OK }, { agy: '{"nivel":"simple","dominio":"qa","tipo":"bug"}' });
    const c = cadena(b.backend, { ...OPC, maxGeminiPorEjecucion: 1 });
    assert.equal((await clasificar(e, observadoDe(e), c)).estado, 'ok');
    const r3 = await clasificar(e, observadoDe(e), c);
    assert.equal(r3.estado, 'pendiente'); assert.match(r3.error!, /tope de 1/); assert.equal(b.llamadas.length, 1);
  });
  it('sin ningún proveedor disponible la tarea queda pendiente (y no inventa etiquetas)', async () => {
    const { backend } = falso({ ollama: { ok: false, motivo: 'ollama no responde' } }, {});
    const e = entrada();
    const r = await clasificar(e, observadoDe(e), cadena(backend));
    assert.equal(r.estado, 'pendiente'); assert.match(r.error!, /ollama no responde/);
    assert.ok(r.etiquetas.every((x) => x.valor === null));
  });
  it('si el modelo responde pero nunca algo válido es un fallo, no una espera', async () => {
    const { backend } = falso({ ollama: OK, agy: OK }, { ollama: 'hola', agy: new Error('cuota agotada') });
    const e = entrada();
    const r = await clasificar(e, observadoDe(e), cadena(backend));
    assert.equal(r.estado, 'fallido'); assert.match(r.error!, /cuota agotada/);
  });
  it('el prompt trata la tarea como datos y parsearRespuesta exige algún eje', () => {
    assert.equal(parsearRespuesta('{"otra":1}'), null); assert.equal(parsearRespuesta('sin json'), null); assert.equal(parsearRespuesta('[1]'), null);
    assert.deepEqual(parsearRespuesta('x {"nivel":"simple"} y'), { nivel: 'simple' });
  });
});

describe('configuración', () => {
  it('lo inválido vuelve al valor por defecto y Gemini va detrás de Ollama', () => {
    const c = configDesde({ cadena: [{ id: 'nada' }], timeoutMs: 'x', limitePorEjecucion: -4, destilacion: { activa: 'sí', proveedor: 'otro' } });
    assert.deepEqual(c.cadena.map((x) => x.id), ['ollama', 'agy']);
    assert.equal(c.limitePorEjecucion, 1); assert.equal(c.destilacion.activa, false); assert.equal(c.destilacion.proveedor, 'claude-cli');
    assert.equal(configDesde(null).cadena[0]!.modelo, 'qwen2.5:14b');
  });
});
