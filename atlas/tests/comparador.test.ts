import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { Biblioteca } from '../src/biblioteca';
import { compararEquipo, compararKarajan, compararSkill, GRUPO_KARAJAN, MUESTRA_MINIMA_GRUPO, pruebasCubiertas, pruebasEnGrupos, type CapacidadKarajan } from '../src/comparador';
import { ejecutar } from '../src/cli';
import { registrar } from '../src/servidor';
import { atlasFalso } from './ayuda-atlas';
import { laboratorioComparador, type ContextoComparador } from '../src/lab/comparador.lab';
import type { SkillDisponible } from '../src/skills-seleccion';

const dir = mkdtempSync(join(tmpdir(), 'karajan-comparador-'));
// En Windows el servidor de las pruebas de ruta puede seguir con sus bases abiertas: limpiar es un esfuerzo, no una condición.
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* lo borra el sistema */ } });

interface Fila { slug: string; kind?: string; grupo?: string | null; estrellas?: number | null; padre?: string | null; tags?: string[]; caps?: string[]; resumen?: string }
/** Un resources.db sintético con solo las tablas y columnas que lee `biblioteca.ts`. */
function crearDb(nombre: string, filas: Fila[]): Biblioteca {
  const ruta = join(dir, nombre);
  const db = new DatabaseSync(ruta);
  db.exec(`CREATE TABLE resources (id TEXT PRIMARY KEY, slug TEXT, name TEXT, kind TEXT, repo_url TEXT, source_url TEXT, summary TEXT, tags_json TEXT, capabilities_json TEXT, metadata_json TEXT, parent_resource_id TEXT, index_status TEXT);
    CREATE TABLE resource_groups (id TEXT PRIMARY KEY, name TEXT);`);
  db.exec(`INSERT INTO resource_groups VALUES ('g1', 'Grupo uno'), ('${GRUPO_KARAJAN}', 'Orquestación y contexto'), ('g2', 'Grupo corto')`);
  const ins = db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const f of filas) {
    const meta = { ...(f.estrellas != null ? { github_stars: f.estrellas } : {}), ...(f.grupo ? { decision_taxonomy: { group_id: f.grupo } } : {}) };
    ins.run(`id-${f.slug}`, f.slug, f.slug, f.kind ?? 'capability', `https://github.com/x/${f.slug}`, null, f.resumen ?? '', JSON.stringify(f.tags ?? ['testing']), JSON.stringify(f.caps ?? []), JSON.stringify(meta), f.padre ? `id-${f.padre}` : null, 'active');
  }
  db.close();
  return new Biblioteca(ruta);
}

/** Seis pares con estrellas propias (1000…6000), la skill del equipo «mi» (3500), una hija con estrellas heredadas, una sin grupo y un grupo corto. */
const filasG1: Fila[] = [
  ...[1, 2, 3, 4, 5, 6].map((n): Fila => ({ slug: `par${n}`, grupo: 'g1', estrellas: n * 1000, tags: ['testing', ...(n >= 5 ? ['prompt-evals', 'llm-eval'] : []), ...(n >= 4 ? ['tracing'] : [])], caps: n >= 5 ? ['evaluation'] : [], resumen: n === 6 ? 'Runs A/B tests of prompts with human feedback' : n === 5 ? 'Benchmark suite' : '' })),
  { slug: 'mi', kind: 'skill', grupo: 'g1', estrellas: 3500, tags: ['testing'], resumen: 'Mi skill' },
  { slug: 'hija', kind: 'skill', grupo: 'g1', estrellas: 6000, padre: 'par6' },
  { slug: 'sin-grupo', kind: 'skill', estrellas: 10 },
  { slug: 'solo', kind: 'skill', grupo: 'g2', estrellas: 50 },
  { slug: 'solo2', kind: 'skill', grupo: 'g2', estrellas: 60 },
  // Relleno sin grupo: que ninguna etiqueta de los pares llegue por azar al 25 % de la biblioteca.
  ...[1, 2, 3, 4].map((n): Fila => ({ slug: `relleno${n}`, kind: 'skill' })),
];

describe('comparador: skills del equipo', () => {
  const bib = crearDb('g1.db', filasG1);
  after(() => bib.cerrar());

  it('listarGrupo e inventario de etiquetas', () => {
    assert.equal(bib.listarGrupo('g1').length, 8);
    assert.equal(bib.frecuenciasTerminos().get('prompt-evals'), 2 / 15);
    assert.equal(bib.nombreGrupo('g1'), 'Grupo uno');
    assert.equal(bib.nombreGrupo('no-existe'), 'no-existe');
    assert.equal(bib.frecuenciasTerminos().get('testing'), 1);
  });

  it('posición y percentil frente a los pares con estrellas propias, sin contar las heredadas', () => {
    const c = compararSkill(bib, { name: 'mi' });
    assert.equal(c.estado, 'comparada');
    assert.equal(c.grupoNombre, 'Grupo uno');
    assert.equal(c.estrellas, 3500);
    assert.equal(c.conDato, 6);
    // 3 pares por debajo, 3 por encima y ella: (3 + 0.5) / 7 = 50 %. La «hija» (estrellas heredadas de par6) no cuenta.
    assert.equal(c.posicion, 4);
    assert.equal(c.percentil, 50);
    assert.deepEqual(c.mejores.map((m) => m.nombre), ['par6', 'par5', 'par4', 'par3', 'par2']);
  });

  it('estrellas heredadas, sin ficha y sin grupo: «sin dato», sin percentil ni funcionalidades', () => {
    const hija = compararSkill(bib, { name: 'hija' });
    assert.equal(hija.estado, 'sin-dato');
    assert.equal(hija.estrellas, null);
    assert.equal(hija.percentil, null);
    assert.equal(hija.posicion, null);
    assert.deepEqual(hija.faltan, []);
    assert.match(hija.motivo, /colección/);
    assert.equal(compararSkill(bib, { name: 'no-esta' }).estado, 'sin-ficha');
    const sg = compararSkill(bib, { name: 'sin-grupo' });
    assert.equal(sg.estado, 'sin-grupo');
    assert.equal(sg.percentil, null);
  });

  it('un grupo con muestra corta se enseña pero no se puntúa', () => {
    const c = compararSkill(bib, { name: 'solo' });
    assert.equal(c.estado, 'grupo-corto');
    assert.equal(c.percentil, null);
    assert.equal(c.posicion, null);
    assert.ok(c.conDato + 1 < MUESTRA_MINIMA_GRUPO);
    assert.deepEqual(c.faltan, []);
  });

  it('funcionalidades: declaradas por ≥ 2 pares, que la skill no ofrece y que no son etiquetas de toda la biblioteca', () => {
    const c = compararSkill(bib, { name: 'mi', description: 'Hace tracing de ejecuciones' });
    const f = Object.fromEntries(c.faltan.map((x) => [x.funcionalidad, x.pares]));
    assert.deepEqual(f['prompt-evals'], ['par6', 'par5']);
    assert.deepEqual(f['llm-eval'], ['par6', 'par5']);
    assert.deepEqual(f['evaluation'], ['par6', 'par5']);
    assert.equal('testing' in f, false, '«testing» lo declara toda la biblioteca: no distingue');
    assert.equal('tracing' in f, false, 'su descripción local ya habla de tracing');
    // Sin esa descripción, «tracing» (par4, par5, par6) sí falta.
    assert.deepEqual(compararSkill(bib, { name: 'mi' }).faltan.find((x) => x.funcionalidad === 'tracing')?.pares, ['par6', 'par5', 'par4']);
  });

  it('compararEquipo conserva el orden y no usa la skill como su propio par', () => {
    const r = compararEquipo(bib, [{ name: 'par3' }, { name: 'mi' }]);
    assert.deepEqual(r.map((x) => x.sujeto), ['par3', 'mi']);
    assert.ok(!r[0]!.mejores.some((m) => m.nombre === 'par3'));
    assert.equal(r[0]!.posicion, 5);
  });

  it('empates: el percentil cuenta la mitad de los iguales', () => {
    const b = crearDb('empate.db', [1, 2, 3, 4, 5].map((n): Fila => ({ slug: `p${n}`, grupo: 'g1', estrellas: n * 10 })).concat([{ slug: 'yo', kind: 'skill', grupo: 'g1', estrellas: 30 }]));
    const c = compararSkill(b, { name: 'yo' });
    // 2 por debajo, 2 iguales contándola (p3 y ella) → (2 + 2/2) / 6 = 50 %; puesto 3 (solo p4 y p5 están por encima).
    assert.equal(c.percentil, 50);
    assert.equal(c.posicion, 3);
    b.cerrar();
  });

  it('sin resources.db no inventa nada', () => {
    const vacia = new Biblioteca(null);
    const c = compararSkill(vacia, { name: 'mi' });
    assert.equal(c.estado, 'sin-ficha');
    assert.equal(c.percentil, null);
  });
});

describe('comparador: Karajan y las pruebas con feedback humano', () => {
  const orquesta: Fila[] = [
    { slug: 'ecc', grupo: GRUPO_KARAJAN, estrellas: 5000, tags: ['testing', 'rag', 'multi-agent'], resumen: 'Agent harness with human feedback loops' },
    { slug: 'dify', grupo: GRUPO_KARAJAN, estrellas: 4000, tags: ['testing', 'rag', 'workflow-engine'] },
    { slug: 'gstack', grupo: GRUPO_KARAJAN, estrellas: 3000, tags: ['testing', 'workflow-engine', 'multi-agent'] },
    { slug: 'headroom', grupo: GRUPO_KARAJAN, estrellas: 2000, tags: ['testing', 'token-optimization'], resumen: 'Benchmarks of token savings' },
    { slug: 'dspy', grupo: GRUPO_KARAJAN, estrellas: 1000, tags: ['testing', 'token-optimization'], resumen: 'Pairwise preference optimizers' },
    { slug: 'karajan', kind: 'skill', grupo: GRUPO_KARAJAN, tags: ['testing'] },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n): Fila => ({ slug: `relleno${n}`, kind: 'skill' })),
  ];
  const caps: CapacidadKarajan[] = [
    { id: 'delegador', responsabilidad: 'Elegir el agente de cada subtarea', pruebas: ['contrato', 'replay'] },
    { id: 'selector', responsabilidad: 'Elegir las skills que necesita un prompt', pruebas: ['feedback'] },
  ];
  const bib = crearDb('orquesta.db', orquesta);
  after(() => bib.cerrar());

  it('Karajan figura «sin dato» (no tiene estrellas propias) pero se compara con sus pares', () => {
    const k = compararKarajan(bib, caps);
    assert.equal(k.tipo, 'karajan');
    assert.equal(k.estado, 'sin-dato');
    assert.equal(k.percentil, null);
    assert.equal(k.conDato, 5);
    assert.deepEqual(k.mejores.map((m) => m.nombre), ['ecc', 'dify', 'gstack', 'headroom', 'dspy']);
    const f = Object.fromEntries(k.faltan.map((x) => [x.funcionalidad, x.pares]));
    assert.deepEqual(f['rag'], ['ecc', 'dify']);
    assert.deepEqual(f['multi-agent'], undefined, 'Karajan ya declara multi-agent (delegador)');
    assert.deepEqual(f['token-optimization'], ['headroom', 'dspy']);
    assert.deepEqual(f['workflow-engine'], ['dify', 'gstack']);
  });

  it('las pruebas que Karajan ya tiene (replay, feedback) salen de sus laboratorios', () => {
    assert.deepEqual([...pruebasCubiertas(caps)].sort(), ['feedback-humano', 'preferencia']);
    assert.deepEqual([...pruebasCubiertas([{ id: 'x', responsabilidad: '', pruebas: ['contrato'] }])], []);
    const ids = pruebasEnGrupos(bib, [GRUPO_KARAJAN]).map((p) => p.prueba).sort();
    assert.deepEqual(ids, ['benchmarks', 'feedback-humano', 'preferencia']);
  });

  const ctx = (b: Biblioteca, skills: SkillDisponible[] = []): ContextoComparador => ({ tareas: async () => [], calibraciones: () => [], biblioteca: b, skills: () => skills, capacidades: () => caps });
  const skill = (name: string): SkillDisponible => ({ name, description: '', instaladaEn: ['claude'], enAlmacen: [] });

  it('laboratorio: una prueba sin cubrir es un hallazgo media con evidencia y criterio, y lo cubierto no', async () => {
    const r = await laboratorioComparador.escenarios[1]!.ejecutar(ctx(bib));
    assert.equal(r.suficiente, true);
    assert.equal(r.muestra, 5);
    const pruebas = r.hallazgos.filter((h) => h.clave.startsWith('prueba-'));
    assert.deepEqual(pruebas.map((h) => h.clave), ['prueba-benchmarks']);
    const h = pruebas[0]!;
    assert.equal(h.severidad, 'media');
    assert.match(h.titulo, /Añadir al laboratorio la prueba «benchmarks repetibles» inspirada en headroom/);
    assert.match(h.evidencia, /headroom \(2\.000 ★\)/);
    assert.ok(h.criterios!.length >= 4);
    assert.equal(r.metricas['pruebas_sin_cubrir'], 1);
    assert.equal(r.metricas['pruebas_que_karajan_ya_tiene'], 2);
    // Las funcionalidades declaradas por 2 pares solo son informativas (baja): ninguna llega a 3 pares.
    const fun = r.hallazgos.find((x) => x.clave === 'funcionalidades-karajan-menores');
    assert.equal(fun?.severidad, 'baja');
    assert.equal(r.hallazgos.some((x) => x.clave === 'funcionalidades-karajan'), false);
  });

  it('laboratorio: con una funcionalidad en ≥ 3 pares sale un hallazgo media', async () => {
    const b = crearDb('tres.db', orquesta.map((f) => (['ecc', 'dify', 'gstack'].includes(f.slug) ? { ...f, tags: [...(f.tags ?? []), 'tracing'] } : f)));
    const r = await laboratorioComparador.escenarios[1]!.ejecutar(ctx(b));
    const h = r.hallazgos.find((x) => x.clave === 'funcionalidades-karajan');
    assert.equal(h?.severidad, 'media');
    assert.match(h!.evidencia, /tracing \(ecc, dify, gstack\)/);
    b.cerrar();
  });

  it('laboratorio: con menos de la muestra mínima da métricas pero ningún hallazgo de ellas', async () => {
    const b = crearDb('corta.db', orquesta.slice(0, 3).concat(orquesta.slice(5)));
    const r = await laboratorioComparador.escenarios[1]!.ejecutar(ctx(b));
    assert.equal(r.suficiente, false);
    assert.equal(r.hallazgos.filter((h) => h.severidad !== 'baja').length, 0);
    assert.equal(r.metricas['pares_con_estrellas_propias'], 3);
    b.cerrar();
  });

  it('laboratorio (contrato): ninguna estrella heredada ni percentil con muestra corta, y la cobertura', async () => {
    const b = crearDb('contrato.db', filasG1);
    const r = await laboratorioComparador.escenarios[0]!.ejecutar(ctx(b, ['mi', 'hija', 'solo', 'sin-grupo', 'no-esta'].map(skill)));
    assert.equal(r.suficiente, true);
    assert.equal(r.metricas['con_estrellas_heredadas'], 0);
    assert.equal(r.metricas['pares_sin_estrellas_propias'], 0);
    assert.equal(r.metricas['percentiles_con_muestra_corta'], 0);
    assert.equal(r.metricas['comparadas'], 0.2);
    assert.equal(r.hallazgos.some((h) => h.clave === 'contrato-roto'), false);
    b.cerrar();
  });

  it('laboratorio sin resources.db: un hallazgo y muestra insuficiente', async () => {
    for (const e of laboratorioComparador.escenarios) {
      const r = await e.ejecutar(ctx(new Biblioteca(null), [skill('mi')]));
      assert.equal(r.suficiente, false);
      assert.equal(r.hallazgos[0]!.clave, 'sin-biblioteca');
    }
  });

  it('laboratorio: nunca escribe en la biblioteca (se abre en solo lectura)', () => {
    const b = crearDb('ro.db', orquesta);
    assert.throws(() => (b as unknown as { db: DatabaseSync }).db.exec('DELETE FROM resources'));
    b.cerrar();
  });
});

describe('kj comparar', () => {
  const correr = async (args: string[], respuesta: unknown) => {
    const pedidas: string[] = [];
    let texto = '';
    const codigo = await ejecutar(args, { fetch: async (url) => { pedidas.push(url.replace('http://k', '')); return { ok: true, status: 200, json: async () => respuesta }; }, escribir: (x) => { texto += `${x}\n`; }, api: 'http://k' });
    return { codigo, texto, pedidas };
  };
  const comp = { sujeto: 'mi', estado: 'comparada', motivo: '', grupoNombre: 'Grupo uno', estrellas: 3500, posicion: 4, percentil: 50, conDato: 6, mejores: [{ nombre: 'par6', estrellas: 6000 }, { nombre: 'par5', estrellas: 5000 }], faltan: [{ funcionalidad: 'llm-eval', pares: ['par6', 'par5'] }] };

  it('una skill: puesto, barras de estrellas y funcionalidades', async () => {
    const r = await correr(['comparar', 'mi', '--grupo', 'g1'], comp);
    assert.equal(r.codigo, 0);
    assert.equal(r.pedidas[0], '/laboratorio/comparar?skill=mi&grupo=g1');
    assert.match(r.texto, /mi · Grupo uno · comparada · puesto 4 \(p50, 3500★ propias\)/);
    assert.match(r.texto, /par6 +█+·* 6000/);
    assert.match(r.texto, /• llm-eval {2}\(par6, par5\)/);
  });

  it('todo el equipo: barras del percentil y lista de «sin dato»', async () => {
    const r = await correr(['comparar'], { skills: [comp, { ...comp, sujeto: 'hija', estado: 'sin-dato', percentil: null, posicion: null, estrellas: null }] });
    assert.equal(r.pedidas[0], '/laboratorio/comparar?skill=&grupo=');
    assert.match(r.texto, /1 de 2 skills comparables/);
    assert.match(r.texto, /mi .*p50/);
    assert.match(r.texto, /Sin dato \(1\): hija \[sin-dato\]/);
  });

  it('karajan: sus pares y las pruebas que declaran; --json da los datos tal cual', async () => {
    const datos = { karajan: { ...comp, sujeto: 'karajan', estado: 'sin-dato', percentil: null, posicion: null, estrellas: null }, pruebas: [{ nombre: 'benchmarks repetibles', pares: [{ par: 'headroom', estrellas: 2000 }] }] };
    const r = await correr(['comparar', 'karajan'], datos);
    assert.match(r.texto, /karajan · Grupo uno · sin-dato · sin dato: no se puntúa/);
    assert.match(r.texto, /• benchmarks repetibles: headroom \(2000★\)/);
    assert.deepEqual(JSON.parse((await correr(['comparar', 'karajan', '--json'], datos)).texto), datos);
  });
});

describe('GET /laboratorio/comparar', () => {
  type Manejador = (req: Record<string, unknown>, reply: { code(n: number): unknown }) => unknown;
  const rutas = new Map<string, Manejador>();
  let errores: (e: Error & { status?: number }, req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => unknown = () => undefined;
  const entorno: Record<string, string | undefined> = {};
  const fetchOriginal = globalThis.fetch;
  const casa = join(dir, 'casa');
  const sinDb = new Map<string, Manejador>();

  const montar = async (destino: Map<string, Manejador>, resources: string, datos: string) => {
    process.env['ATLAS_KARAJAN_RESOURCES'] = resources;
    const app = { get: (r: string, f: Manejador) => destino.set(`GET ${r}`, f), post: (r: string, f: Manejador) => destino.set(`POST ${r}`, f), put: (r: string, f: Manejador) => destino.set(`PUT ${r}`, f), setErrorHandler: (f: typeof errores) => { errores = f; } };
    await registrar(app as never, { id: 'karajan', version: '0.8.0', datos });
  };
  before(async () => {
    for (const k of ['ATLAS_KARAJAN_DATA', 'ATLAS_WORKSPACE', 'ATLAS_KARAJAN_LAYOUT', 'ATLAS_DEV_API', 'ATLAS_KARAJAN_RESOURCES', 'USERPROFILE', 'HOME']) entorno[k] = process.env[k];
    // Ni las skills ni los datos reales del equipo: todo en el temporal.
    process.env['USERPROFILE'] = casa; process.env['HOME'] = casa;
    delete process.env['ATLAS_KARAJAN_DATA']; process.env['ATLAS_WORKSPACE'] = dir; process.env['ATLAS_DEV_API'] = 'http://127.0.0.1:4100';
    delete process.env['ATLAS_KARAJAN_LAYOUT'];
    globalThis.fetch = atlasFalso().fetch as unknown as typeof fetch;
    crearDb('ruta.db', filasG1).cerrar();
    await montar(rutas, join(dir, 'ruta.db'), join(dir, 'paquete'));
    await montar(sinDb, join(dir, 'no-hay.db'), join(dir, 'paquete2'));
  });
  after(() => {
    globalThis.fetch = fetchOriginal;
    for (const [k, v] of Object.entries(entorno)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const llamar = async (destino: Map<string, Manejador>, query: Record<string, string>) => {
    try { return { status: 200, body: await destino.get('GET /laboratorio/comparar')!({ query, params: {}, headers: {}, body: null }, { code: () => undefined }) as Record<string, unknown> }; } catch (e) {
      let r: { status: number; body: Record<string, unknown> } = { status: 0, body: {} };
      errores(e as Error, null, { code: (n) => ({ send: (b) => { r = { status: n, body: b as Record<string, unknown> }; } }) });
      return r;
    }
  };

  it('una skill por nombre, Karajan y el equipo entero (vacío si no hay skills instaladas)', async () => {
    const mi = await llamar(rutas, { skill: 'mi' });
    assert.equal(mi.status, 200);
    assert.equal(mi.body['percentil'], 50);
    const k = await llamar(rutas, { skill: 'karajan' });
    assert.equal(k.status, 200);
    assert.equal((k.body['karajan'] as { tipo: string }).tipo, 'karajan');
    assert.ok(Array.isArray(k.body['pruebas']));
    assert.deepEqual((await llamar(rutas, {})).body, { skills: [] });
  });

  it('sin resources.db responde 409 y no inventa nada', async () => {
    const r = await llamar(sinDb, { skill: 'mi' });
    assert.equal(r.status, 409);
    assert.match(String(r.body['detail']), /resources\.db/);
  });
});
