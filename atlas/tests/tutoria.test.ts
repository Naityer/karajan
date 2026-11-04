import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Fetch } from '../src/atlas-dev';
import { actualizarCatalogo, combinar, elegirTutores, leerCatalogo, normalizar, type CatalogoTutores, type ModeloTutor } from '../src/tutor';
import { agrupar, calificacion, calificar, extraerJson, ficherosDeDiff, filtrarPista, solape, UMBRALES_TUTORIA, type ExamenAnonimo } from '../src/tutoria-nota';
import { laboratorioTutor, type ContextoTutor } from '../src/lab/tutor.lab';
import { laboratorioTutoria, type ContextoTutoria } from '../src/lab/tutoria.lab';

const dir = mkdtempSync(join(tmpdir(), 'karajan-tutoria-'));
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* lo borra el sistema */ } });

const m = (proveedor: ModeloTutor['proveedor'], modelo: string, razonamiento: number, e: number, s: number): ModeloTutor => ({ proveedor, modelo, razonamiento, precioEntrada: e, precioSalida: s, fuente: 'test' });
const AHORA = Date.parse('2026-11-04T00:00:00Z');
const catalogo: CatalogoTutores = {
  actualizado: '2026-11-03T00:00:00Z',
  modelos: [
    m('claude-cli', 'claude-sonnet-5-5', 60, 3, 15), m('claude-cli', 'claude-opus-5-5', 70, 15, 75), m('claude-cli', 'claude-haiku-4-5', 30, 1, 5),
    m('codex', 'gpt-6-luna', 58, 1, 8), m('codex', 'gpt-6', 66, 5, 30), m('codex', 'gpt-6-nano', 20, 0.1, 0.4),
  ],
};

describe('tutor: elección por razonamiento/precio', () => {
  it('elige por proveedor el de más valor entre los que razonan ≥ 75 % del mejor (el barato y torpe no gana)', () => {
    const s = elegirTutores(catalogo, { ahora: AHORA });
    assert.deepEqual(s.porProveedor.map((e) => e.modelo), ['claude-sonnet-5-5', 'gpt-6-luna']);
    assert.equal(s.tutor?.modelo, 'gpt-6-luna', 'luna: 58 pts a 2,75 USD mezclados frente a 60 pts a 6');
    assert.equal(s.obsoleto, false);
  });

  it('es determinista con el catálogo en cualquier orden', () => {
    const a = elegirTutores(catalogo, { ahora: AHORA }).tutor, b = elegirTutores({ ...catalogo, modelos: [...catalogo.modelos].reverse() }, { ahora: AHORA }).tutor;
    assert.deepEqual(a, b);
  });

  it('respeta los proveedores no disponibles y los excluidos, y avisa', () => {
    assert.equal(elegirTutores(catalogo, { disponibles: ['claude-cli'], ahora: AHORA }).tutor?.proveedor, 'claude-cli');
    const s = elegirTutores(catalogo, { excluir: ['claude-cli', 'codex'], ahora: AHORA });
    assert.equal(s.tutor, null);
    assert.ok(s.avisos.some((a) => /Ningún proveedor/.test(a)));
  });

  it('marca el catálogo viejo y no hay tutor sin catálogo', () => {
    assert.equal(elegirTutores(catalogo, { ahora: AHORA + 8 * 86_400_000 }).obsoleto, true);
    assert.equal(elegirTutores(null).tutor, null);
    assert.equal(elegirTutores({ actualizado: catalogo.actualizado, modelos: [m('codex', 'x', 0, 1, 1)] }).tutor, null, 'sin razonamiento medido no entra');
  });

  it('normaliza nombres de distintas fuentes y combina razonamiento con precio', () => {
    assert.equal(normalizar('anthropic/claude-sonnet-5.5:beta'), 'claude-sonnet-5-5');
    assert.equal(normalizar('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
    const r = combinar(
      [{ id: 'claude-sonnet-5-5', creador: 'anthropic', razonamiento: 60, entrada: null, salida: null }, { id: 'llama-9', creador: 'meta', razonamiento: 80, entrada: 1, salida: 1 }, { id: 'gpt-6-luna', creador: 'openai', razonamiento: null, entrada: 1, salida: 1 }],
      [{ id: 'claude-sonnet-5-5', creador: 'anthropic', razonamiento: null, entrada: 3, salida: 15 }],
    );
    assert.deepEqual(r.map((x) => [x.proveedor, x.modelo, x.precioEntrada, x.precioSalida]), [['claude-cli', 'claude-sonnet-5-5', 3, 15]]);
  });
});

describe('tutor: actualización automática', () => {
  const respuesta = (cuerpo: unknown, status = 200) => ({ ok: status < 400, status, json: async () => cuerpo });
  const fuentes = (aa: unknown, or: unknown, aaStatus = 200): Fetch => async (url) => (url.includes('artificialanalysis') ? respuesta(aa, aaStatus) : respuesta(or));
  const aa = { data: [{ slug: 'claude-sonnet-5-5', model_creator: { slug: 'anthropic' }, evaluations: { artificial_analysis_intelligence_index: 60 } }, { slug: 'gpt-6-luna', model_creator: { slug: 'openai' }, evaluations: { artificial_analysis_intelligence_index: 58 } }] };
  const or = { data: [{ id: 'anthropic/claude-sonnet-5.5', pricing: { prompt: '0.000003', completion: '0.000015' } }, { id: 'openai/gpt-6-luna', pricing: { prompt: '0.000001', completion: '0.000008' } }] };

  it('escribe el catálogo con las dos fuentes, pasando el precio por token a USD por millón', async () => {
    const ruta = join(dir, 'a', 'tutores.json');
    const r = await actualizarCatalogo(ruta, { fetch: fuentes(aa, or), clave: 'k', ahora: () => new Date('2026-11-04T00:00:00Z') });
    assert.equal(r.error, null);
    assert.equal(r.despues?.modelo, 'gpt-6-luna');
    assert.equal(r.cambio, true);
    const c = leerCatalogo(ruta)!;
    assert.deepEqual(c.modelos.map((x) => [x.modelo, x.precioEntrada, x.precioSalida]), [['claude-sonnet-5-5', 3, 15], ['gpt-6-luna', 1, 8]]);
    // Una semana después sale otro modelo mejor: el cambio se detecta.
    const aa2 = { data: [...aa.data, { slug: 'gpt-6-sol', model_creator: { slug: 'openai' }, evaluations: { artificial_analysis_intelligence_index: 60 } }] };
    const or2 = { data: [...or.data, { id: 'openai/gpt-6-sol', pricing: { prompt: '0.0000005', completion: '0.000004' } }] };
    const r2 = await actualizarCatalogo(ruta, { fetch: fuentes(aa2, or2), clave: 'k' });
    assert.equal(r2.despues?.modelo, 'gpt-6-sol');
    assert.equal(r2.antes?.modelo, 'gpt-6-luna');
    assert.equal(r2.cambio, true);
  });

  it('si falla una fuente o no hay clave, el catálogo anterior no se toca', async () => {
    const ruta = join(dir, 'b', 'tutores.json');
    await actualizarCatalogo(ruta, { fetch: fuentes(aa, or), clave: 'k' });
    const antes = readFileSync(ruta, 'utf8');
    const caido = await actualizarCatalogo(ruta, { fetch: fuentes({}, or, 500), clave: 'k' });
    assert.match(caido.error ?? '', /500/);
    const sinClave = await actualizarCatalogo(ruta, { fetch: fuentes(aa, or), clave: null });
    assert.match(sinClave.error ?? '', /ARTIFICIAL_ANALYSIS_API_KEY/);
    assert.equal(readFileSync(ruta, 'utf8'), antes);
    assert.equal(sinClave.despues?.modelo, 'gpt-6-luna', 'sigue con el tutor anterior');
  });

  it('sin OpenRouter usa el precio de Artificial Analysis si lo trae', async () => {
    const ruta = join(dir, 'c', 'tutores.json');
    const conPrecio = { data: [{ slug: 'gpt-6-luna', model_creator: { slug: 'openai' }, evaluations: { artificial_analysis_intelligence_index: 58 }, pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 8 } }] };
    const f: Fetch = async (url) => (url.includes('openrouter') ? respuesta({}, 503) : respuesta(conPrecio));
    const r = await actualizarCatalogo(ruta, { fetch: f, clave: 'k' });
    assert.equal(r.error, null);
    assert.equal(r.catalogo?.modelos[0]?.fuente, 'artificialanalysis');
  });
});

describe('tutoría: pistas, nota y mapa', () => {
  const ref = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@\n+export const total = sumar(items).reduce(acumular, 0);\n+}\n';

  it('el filtro rechaza código, líneas de la solución y pistas largas, y deja pasar la orientación', () => {
    assert.equal(filtrarPista('Mira esto\n```ts\nx()\n```', ref).ok, false);
    assert.equal(filtrarPista('Pon  export const total = sumar(items).reduce(acumular, 0);  ahí', ref).motivo, 'contiene una línea de la solución');
    assert.equal(filtrarPista('a'.repeat(601), ref).ok, false);
    assert.equal(filtrarPista('', ref).ok, false);
    assert.equal(filtrarPista('Ese error es de permisos: comprueba la carpeta desde la que lanzas el comando.', ref).ok, true);
    assert.equal(filtrarPista('Cierra la llave }', ref).ok, true, 'las líneas triviales no protegen nada');
  });

  it('extrae ficheros del diff y el solape cuenta tocados y nombrados', () => {
    assert.deepEqual(ficherosDeDiff(ref), ['src/x.ts']);
    assert.equal(solape(['a.ts', 'b.ts'], ['A.ts'], ''), 0.5);
    assert.equal(solape(['a.ts', 'b.ts'], [], 'cambié b.ts y a.ts'), 1);
    assert.equal(solape([], ['a.ts'], ''), 0);
  });

  it('la nota pondera veredicto y solape, baja con cada ayuda y sin trabajo es 0', () => {
    const v = { cumple: 100, equivalencia: 80, regresiones: false, motivo: '' };
    assert.equal(calificar({ veredicto: v, solape: 1, ayudas: 0, hizoAlgo: true }), Math.round(0.7 * 90 + 30));
    assert.ok(calificar({ veredicto: v, solape: 1, ayudas: 2, hizoAlgo: true }) < calificar({ veredicto: v, solape: 1, ayudas: 1, hizoAlgo: true }));
    assert.equal(calificar({ veredicto: v, solape: 1, ayudas: 0, hizoAlgo: false }), 0);
    assert.ok(calificar({ veredicto: { ...v, regresiones: true }, solape: 0, ayudas: 0, hizoAlgo: true }) <= 35, 'las regresiones topan el veredicto en 50');
    assert.equal(calificar({ veredicto: { cumple: 500, equivalencia: -4, regresiones: false, motivo: '' }, solape: 7, ayudas: 0, hizoAlgo: true } as never) <= 100, true);
  });

  it('extrae el JSON aunque venga rodeado de texto', () => {
    assert.deepEqual(extraerJson('Claro:\n```json\n{"a":1}\n```\nlisto'), { a: 1 });
    assert.deepEqual(extraerJson('{"a":{"b":2}} y {raro'), { a: { b: 2 } });
    assert.equal(extraerJson('sin json'), null);
  });

  const ex = (nivel: number, nota: number | null, ayudas = 0, dominio = 'backend'): ExamenAnonimo => ({ tarea: `h${Math.random()}`, dominio, nivel, alumno: 'a/m', tutor: 't/m', nota, ayudas, ayudasRechazadas: 0, ms: 1, fecha: '', motivo: '', obstaculos: [] });
  it('el mapa solo da por delegable un nivel con muestra y aprobación segura, y el máximo es contiguo', () => {
    const examenes = [...Array(8).fill(0).map(() => ex(1, 90)), ...Array(8).fill(0).map(() => ex(2, 80)), ...Array(6).fill(0).map((_, i) => ex(3, i < 2 ? 90 : 20)), ex(4, 100), ex(4, null)];
    const c = calificacion(examenes);
    assert.equal(c.nivelMaximoDelegable, 2);
    assert.equal(c.porNivel.find((s) => s.clave === 'N4')!.delegable, false, 'n=1 no basta aunque sea 100');
    assert.equal(c.porNivel.find((s) => s.clave === 'N3')!.delegable, false);
    assert.equal(c.sinCalificar, 1);
    assert.equal(c.nota, Math.round(examenes.filter((e) => e.nota !== null).reduce((s, e) => s + e.nota!, 0) / 23));
    assert.equal(calificacion([]).nota, null);
    assert.equal(agrupar(examenes, (e) => e.dominio)[0]!.n, 23);
    // Un nivel intermedio sin muestra corta la cadena: N1 delegable, N2 corto, N3 bueno → solo N1.
    assert.equal(calificacion([...Array(8).fill(0).map(() => ex(1, 90)), ...Array(8).fill(0).map(() => ex(3, 90))]).nivelMaximoDelegable, 1);
    assert.equal(UMBRALES_TUTORIA.aprobado, 70);
  });
});

describe('laboratorios del tutor y la tutoría', () => {
  const baseCtx = { tareas: async () => [], calibraciones: () => [] };

  it('tutor · seleccion: sin hallazgos con catálogo fresco, y los da con catálogo viejo o ausente', async () => {
    const ctx = (c: CatalogoTutores | null, ahora = AHORA): ContextoTutor => ({ ...baseCtx, catalogo: () => c, disponibles: () => ['claude-cli', 'codex'], excluir: () => [], ahora: () => ahora });
    const esc = laboratorioTutor.escenarios[0]!;
    const ok = await esc.ejecutar(ctx(catalogo));
    assert.deepEqual(ok.hallazgos, []);
    assert.equal(ok.metricas['determinista'], 1);
    assert.deepEqual((await esc.ejecutar(ctx(catalogo, AHORA + 30 * 86_400_000))).hallazgos.map((h) => h.clave), ['catalogo-obsoleto']);
    const sin = await esc.ejecutar(ctx(null));
    assert.deepEqual(sin.hallazgos.map((h) => h.clave), ['sin-catalogo']);
    assert.equal(sin.suficiente, false);
  });

  it('tutoría · contrato: el examen recorre alumno → tutor → alumno → veredicto sin ver la referencia y sin dejar rastro', async () => {
    const r = await laboratorioTutoria.escenarios.find((e) => e.id === 'contrato')!.ejecutar({} as ContextoTutoria);
    assert.deepEqual(r.hallazgos, [], JSON.stringify(r.hallazgos));
    assert.ok((r.metricas['comprobaciones'] ?? 0) >= 12);
  });

  it('tutoría · examen: sin autorización no ejecuta nada (cuesta tokens)', async () => {
    let tocado = false;
    const ctx = { ...baseCtx, tareasReales: async () => { tocado = true; return []; }, previos: () => [] as ExamenAnonimo[], autorizado: () => false } as unknown as ContextoTutoria;
    const r = await laboratorioTutoria.escenarios.find((e) => e.id === 'examen')!.ejecutar(ctx);
    assert.equal(r.suficiente, false);
    assert.equal(r.metricas['autorizado'], 0);
    assert.equal(tocado, false);
    assert.deepEqual(r.hallazgos, []);
  });
});
