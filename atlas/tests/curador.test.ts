import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FichaRecurso } from '../src/biblioteca';
import { ejecutar } from '../src/cli';
import { aHallazgo, curar, type EntradaCurador } from '../src/curador';
import { laboratorioCurador, type ContextoCurador } from '../src/lab/curador.lab';

const AHORA = Date.parse('2026-06-01T00:00:00Z');
const hace = (d: number) => new Date(AHORA - d * 86_400_000).toISOString();
const ficha = (grupo: string | null, estrellas: number | null, heredadas = false): FichaRecurso => ({ nombre: 'x', slug: 'x', tipo: 'skill', descripcion: '', estrellas, heredadas, repo_url: null, grupo, capacidades: [] });
const skill = (name: string, extra: Partial<EntradaCurador['skills'][number]> = {}) => ({ name, description: `hace ${name}`, instaladaEn: ['claude'], enAlmacen: [] as string[], ...extra });

/** Entrada sintética: todo sano salvo lo que cada test cambia. */
const entrada = (e: Partial<EntradaCurador> = {}): EntradaCurador => ({
  ahora: AHORA, skills: [], fichas: {}, usos: {}, recomendadas: {}, registroDesde: hace(200), protegidas: [], ...e,
});
const reglas = (e: EntradaCurador) => curar(e).map((p) => `${p.regla}:${p.skill}`);

describe('curador: sin-uso-ni-recomendacion', () => {
  it('dispara con skill sin uso ni recomendación en la ventana y registro suficiente', () => {
    const p = curar(entrada({ skills: [skill('vieja'), skill('nunca')], usos: { vieja: { ultimo: hace(120), n: 3 } } }));
    assert.deepEqual(p.map((x) => [x.skill, x.regla, x.accion]), [['nunca', 'sin-uso-ni-recomendacion', 'retirar'], ['vieja', 'sin-uso-ni-recomendacion', 'retirar']]);
    assert.match(p[1]!.evidencia, /Último uso: 2026-0\d-\d\d \(3 usos registrados\)/);
    assert.match(p[0]!.evidencia, /Último uso: nunca/);
  });
  it('no dispara si hubo uso o recomendación dentro de la ventana', () => {
    const e = entrada({ skills: [skill('usada'), skill('recomendada')], usos: { usada: { ultimo: hace(10), n: 1 } }, recomendadas: { recomendada: { ultima: hace(30), n: 2 } } });
    assert.deepEqual(reglas(e), []);
  });
  it('no concluye nada si el registro es más corto que la ventana (o no existe)', () => {
    assert.deepEqual(reglas(entrada({ skills: [skill('nueva')], registroDesde: hace(30) })), []);
    assert.deepEqual(reglas(entrada({ skills: [skill('nueva')], registroDesde: null })), []);
  });
  it('respeta los umbrales explícitos', () => {
    assert.deepEqual(reglas(entrada({ skills: [skill('a')], usos: { a: { ultimo: hace(20), n: 1 } }, umbrales: { diasSinUso: 15 } })), ['sin-uso-ni-recomendacion:a']);
  });
});

describe('curador: duplicada', () => {
  it('dispara si está instalada y en el almacén del mismo destino', () => {
    const e = entrada({ skills: [skill('doble', { instaladaEn: ['claude', 'codex'], enAlmacen: ['codex'] })], usos: { doble: { ultimo: hace(1), n: 1 } } });
    const p = curar(e);
    assert.deepEqual(p.map((x) => [x.regla, x.accion]), [['duplicada', 'revisar']]);
    assert.match(p[0]!.evidencia, /codex/);
  });
  it('no dispara si está en destinos distintos (instalada en uno, guardada en otro)', () => {
    assert.deepEqual(reglas(entrada({ skills: [skill('x', { instaladaEn: ['claude'], enAlmacen: ['codex'] })], usos: { x: { ultimo: hace(1), n: 1 } } })), []);
  });
});

describe('curador: sin-descripcion', () => {
  it('dispara con descripción vacía o en blanco y no con una normal', () => {
    const e = entrada({ skills: [skill('muda', { description: '  ' }), skill('buena')], usos: { muda: { ultimo: hace(1), n: 1 }, buena: { ultimo: hace(1), n: 1 } } });
    assert.deepEqual(reglas(e), ['sin-descripcion:muda']);
  });
});

describe('curador: superada-por-grupo', () => {
  const base = () => entrada({
    skills: [skill('floja'), skill('fuerte')],
    fichas: { floja: ficha('pdf', 12), fuerte: ficha('pdf', 4000) },
    usos: { fuerte: { ultimo: hace(5), n: 9 } },
  });
  it('dispara con estrellas propias bajas y una del grupo usada con ≥ 10×', () => {
    const p = curar(base()).filter((x) => x.regla === 'superada-por-grupo');
    assert.equal(p.length, 1);
    assert.equal(p[0]!.skill, 'floja');
    assert.equal(p[0]!.accion, 'retirar');
    assert.match(p[0]!.evidencia, /12 estrellas propias.*fuerte tiene 4000/);
  });
  it('no dispara si el rival no tiene 10×, no se usa, es de otro grupo o no está instalado', () => {
    const f = (e: EntradaCurador) => reglas(e).filter((r) => r.startsWith('superada'));
    assert.deepEqual(f({ ...base(), fichas: { floja: ficha('pdf', 12), fuerte: ficha('pdf', 119) } }), []);
    assert.deepEqual(f({ ...base(), usos: {} }), []);
    assert.deepEqual(f({ ...base(), fichas: { floja: ficha('pdf', 12), fuerte: ficha('docx', 4000) } }), []);
    assert.deepEqual(f({ ...base(), skills: [skill('floja'), skill('fuerte', { instaladaEn: [], enAlmacen: ['claude'] })] }), []);
  });
  it('no dispara si la floja se usa o no baja del mínimo', () => {
    const f = (e: EntradaCurador) => reglas(e).filter((r) => r.startsWith('superada'));
    assert.deepEqual(f({ ...base(), usos: { fuerte: { ultimo: hace(5), n: 9 }, floja: { ultimo: hace(2), n: 1 } } }), []);
    assert.deepEqual(f({ ...base(), fichas: { floja: ficha('pdf', 500), fuerte: ficha('pdf', 40000) } }), []);
  });
  it('las estrellas heredadas nunca cuentan, ni en la floja ni en el rival', () => {
    const f = (e: EntradaCurador) => reglas(e).filter((r) => r.startsWith('superada'));
    assert.deepEqual(f({ ...base(), fichas: { floja: ficha('pdf', 12, true), fuerte: ficha('pdf', 4000) } }), []);
    assert.deepEqual(f({ ...base(), fichas: { floja: ficha('pdf', 12), fuerte: ficha('pdf', 4000, true) } }), []);
    assert.deepEqual(f({ ...base(), fichas: { floja: ficha('pdf', null), fuerte: ficha('pdf', 4000) } }), []);
  });
});

describe('curador: protegidas, orden y determinismo', () => {
  it('una protegida nunca se propone, con cualquier regla', () => {
    const e = entrada({ skills: [skill('router', { description: '', instaladaEn: ['claude'], enAlmacen: ['claude'] }), skill('otra')], protegidas: ['router'] });
    assert.deepEqual(reglas(e), ['sin-uso-ni-recomendacion:otra']);
  });
  it('mismo resultado con otro orden de entrada, ordenado por regla y skill', () => {
    const skills = [skill('c'), skill('a', { description: '' }), skill('b')];
    const e = entrada({ skills });
    const r = reglas(e);
    assert.deepEqual(r, ['sin-uso-ni-recomendacion:a', 'sin-uso-ni-recomendacion:b', 'sin-uso-ni-recomendacion:c', 'sin-descripcion:a']);
    assert.deepEqual(reglas({ ...e, skills: [...skills].reverse() }), r);
    assert.deepEqual(curar(e), curar(e));
  });
  it('la propuesta se convierte en un hallazgo con clave <regla>:<skill>', () => {
    const h = aHallazgo(curar(entrada({ skills: [skill('x')] }))[0]!);
    assert.equal(h.clave, 'sin-uso-ni-recomendacion:x');
    assert.equal(h.severidad, 'media');
    assert.match(h.evidencia, /Último uso: nunca/);
  });
});

describe('kj curador', () => {
  const propuestas = [{ skill: 'a', regla: 'sin-descripcion', accion: 'revisar', evidencia: 'e1' }, { skill: 'b', regla: 'sin-uso-ni-recomendacion', accion: 'retirar', evidencia: 'e2', borrador: { tarea: 't1', accion: 'creada' } }];
  const correr = async (args: string[]) => {
    const pedidas: { url: string; metodo: string }[] = [];
    let texto = '';
    const fetch = async (url: string, init?: { method?: string }) => { pedidas.push({ url: url.replace('http://k', ''), metodo: init?.method ?? 'GET' }); return { ok: true, status: 200, json: async () => ({ propuestas }) }; };
    const codigo = await ejecutar(args, { fetch, escribir: (x) => { texto += `${x}\n`; }, api: 'http://k' });
    return { codigo, texto, pedidas };
  };
  it('lista por regla (solo lectura) y con --proponer usa el POST', async () => {
    const r = await correr(['curador']);
    assert.deepEqual(r.pedidas, [{ url: '/laboratorio/curador', metodo: 'GET' }]);
    assert.match(r.texto, /sin-descripcion \(revisar\) · 1\n {2}a {2}e1/);
    const p = await correr(['curador', '--proponer']);
    assert.deepEqual(p.pedidas, [{ url: '/laboratorio/curador/proponer', metodo: 'POST' }]);
    assert.match(p.texto, /→ borrador t1 \(creada\)/);
  });
});

describe('laboratorio del curador', () => {
  const ctx = (e: EntradaCurador, borradores: { clave: string; estado: string }[] = []): ContextoCurador => ({
    tareas: async () => [], calibraciones: () => [], entrada: () => e, borradores: async () => borradores,
  });
  const escenario = (id: string) => laboratorioCurador.escenarios.find((x) => x.id === id)!;
  const sano = entrada({ skills: [skill('a'), skill('b', { description: '' }), skill('router')], protegidas: ['router'], usos: { router: { ultimo: hace(1), n: 1 } } });

  it('contrato: cumple las invariantes con datos sanos', async () => {
    const r = await escenario('invariantes').ejecutar(ctx(sano));
    assert.equal(r.suficiente, true);
    assert.deepEqual(r.hallazgos, []);
    assert.equal(r.metricas['determinista'], 1);
    assert.equal(r.metricas['protegidas_propuestas'], 0);
    assert.equal(r.metricas['sin_evidencia'], 0);
    assert.equal(r.metricas['basadas_en_heredadas'], 0);
    assert.equal(r.metricas['propuestas'], 3);
  });
  it('contrato: sin skills la muestra es insuficiente', async () => {
    assert.equal((await escenario('invariantes').ejecutar(ctx(entrada()))).suficiente, false);
  });

  const lote = (a: number, d: number, regla = 'sin-uso-ni-recomendacion') => [
    ...Array.from({ length: a }, (_, i) => ({ clave: `curador:${regla}:a${i}`, estado: 'completada' })),
    ...Array.from({ length: d }, (_, i) => ({ clave: `curador:${regla}:d${i}`, estado: 'descartada' })),
    { clave: 'curador:duplicada:p', estado: 'borrador' }, { clave: 'selector:otro', estado: 'descartada' },
  ];
  it('feedback: con muestra corta da métricas pero ningún hallazgo', async () => {
    const r = await escenario('precision').ejecutar(ctx(sano, lote(1, 9)));
    assert.equal(r.suficiente, false);
    assert.equal(r.muestra, 10);
    assert.equal(r.metricas['precision'], 0.1);
    assert.equal(r.metricas['pendientes'], 1);
    assert.deepEqual(r.hallazgos, []);
  });
  it('feedback: con muestra suficiente y la mayoría descartada (Wilson) propone ajustar la regla', async () => {
    const r = await escenario('precision').ejecutar(ctx(sano, lote(2, 28)));
    assert.equal(r.suficiente, true);
    assert.equal(r.hallazgos.length, 1);
    assert.equal(r.hallazgos[0]!.clave, 'precision-sin-uso-ni-recomendacion');
    assert.ok(r.metricas['precision_ic_sup']! < 0.5);
  });
  it('feedback: si la persona acepta, no hay hallazgo', async () => {
    const r = await escenario('precision').ejecutar(ctx(sano, lote(25, 5)));
    assert.equal(r.suficiente, true);
    assert.deepEqual(r.hallazgos, []);
  });
  it('feedback: sin borradores previos no hay precisión', async () => {
    const r = await escenario('precision').ejecutar(ctx(sano, []));
    assert.equal(r.metricas['precision'], null);
    assert.equal(r.suficiente, false);
  });
});
