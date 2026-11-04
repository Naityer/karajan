import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Fetch } from '../src/atlas-dev';
import type { Ejecutor, Proveedor } from '../src/proveedores';
import { aplicables, carpetaSkillForge, claveSkillForge, efectoForjadas, informeBrechas, interpretarSkills, leerSkillsForjadas, type SkillForjada } from '../src/skillforge';
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

describe('skillforge: el puente entre la tutoría y la skill skillforge-lab', () => {
  const ex = (tarea: string, nota: number | null, forjadas?: string[], dominio = 'backend', nivel = 2): ExamenAnonimo => ({ tarea, dominio, nivel, alumno: 'ollama-qwen/qwen2.5:7b', tutor: 'codex/gpt-6-luna', nota, ayudas: 0, ayudasRechazadas: 0, ms: 1, fecha: '', motivo: '', obstaculos: nota !== null && nota < 70 ? ['skill'] : [], ...(forjadas ? { forjadas } : {}) });

  it('traduce el alumno al modelo de SkillForge y rechaza lo que no entiende', () => {
    assert.equal(claveSkillForge('ollama-qwen', 'qwen2.5:7b'), 'ollama:qwen2.5:7b');
    assert.equal(claveSkillForge('claude-cli', 'sonnet'), 'claude:sonnet');
    assert.equal(claveSkillForge('otro', 'x'), null);
    assert.equal(carpetaSkillForge({}), null, 'sin laboratorio la integración se apaga');
  });

  it('lee las skills activas sin fiarse de la salida y nunca lanza', () => {
    const bien = { id: 'skill-backend', version: 2, domains: ['backend'], models: ['ollama:qwen2.5:7b'], instructions: 'Haz X.' };
    assert.deepEqual(interpretarSkills(JSON.stringify([bien, { ...bien, id: '../mala' }, { ...bien, instructions: '  ' }, { ...bien, domains: [] }, { ...bien, instructions: 'x'.repeat(16_001) }, null, 7])).map((s) => s.id), ['skill-backend']);
    assert.deepEqual(interpretarSkills('no es json'), []);
    assert.deepEqual(interpretarSkills('{"id":"x"}'), []);
    const llamadas: string[][] = [];
    const ok = leerSkillsForjadas('/lab', { proveedor: 'ollama-qwen', modelo: 'qwen2.5:7b' }, (_c, args) => { llamadas.push(args); return { ok: true, salida: JSON.stringify([bien]) }; });
    assert.equal(ok[0]?.instrucciones, 'Haz X.');
    assert.deepEqual(llamadas[0], ['-m', 'skillforge', 'skills', 'active', '--model', 'ollama:qwen2.5:7b']);
    assert.deepEqual(leerSkillsForjadas('/lab', { proveedor: 'ollama-qwen', modelo: 'm' }, () => ({ ok: false, salida: '' })), []);
    assert.deepEqual(leerSkillsForjadas(null, { proveedor: 'ollama-qwen', modelo: 'm' }, () => { throw new Error('no debe llamarse'); }), []);
    assert.deepEqual(leerSkillsForjadas('/lab', { proveedor: 'otro', modelo: 'm' }, () => { throw new Error('no debe llamarse'); }), []);
    assert.deepEqual(aplicables(ok, 'backend').map((s) => s.id), ['skill-backend']);
    assert.deepEqual(aplicables(ok, 'frontend'), []);
  });

  it('las brechas son agregados anónimos de exámenes sin skill y no llevan ids ni hashes de tarea', () => {
    const examenes = [...Array(6).fill(0).map((_, i) => ex(`hash-secreto-${i}`, 40)), ...Array(6).fill(0).map((_, i) => ex(`otro-${i}`, 95, undefined, 'frontend', 1)), ex('hash-secreto-0', 100, ['skill-backend@v1']), ex('sin-nota', null)];
    const informe = informeBrechas(examenes, { proveedor: 'ollama-qwen', modelo: 'qwen2.5:7b' }, { proveedor: 'codex', modelo: 'gpt-6-luna' }, new Date('2026-11-04T20:00:00Z'));
    assert.equal(informe.schema_version, 1);
    assert.equal(informe.origen, 'karajan-tutoria');
    assert.deepEqual(informe.brechas.map((b) => [b.dominio, b.nivel, b.n, b.delegable]), [['backend', 2, 6, false], ['frontend', 1, 6, true]], 'los exámenes con skill y sin calificar no cuentan');
    assert.deepEqual(informe.brechas[0]!.obstaculos, { skill: 6 });
    assert.doesNotMatch(JSON.stringify(informe), /hash-secreto|otro-|sin-nota/);
  });

  it('el efecto de una skill se mide emparejado por tarea y la nota del alumno no cuenta los exámenes con skill', () => {
    const con = ['skill-backend@v1'];
    const pares = [0, 1, 2, 3, 4, 5].flatMap((i) => [ex(`t${i}`, 50), ex(`t${i}`, i === 5 ? 45 : 70, con)]);
    const [f] = efectoForjadas([...pares, ex('solo-con-skill', 100, con), ex('t0', null, con)]);
    assert.equal(f!.skills, 'skill-backend@v1');
    assert.equal(f!.pares, 6);
    assert.equal(f!.mejoran, 5);
    assert.equal(f!.empeoran, 1);
    assert.equal(f!.deltaMedio, Math.round(((5 * 20 - 5) / 6) * 10) / 10);
    assert.equal(f!.util, true);
    assert.equal(calificacion([...pares]).nota, 50, 'la nota del alumno solo cuenta los exámenes sin skill');
    assert.equal(calificacion([ex('t', 50), ex('t', 100, con)]).examenes, 1);
    // Con poca muestra o con muchos empeoramientos no es útil; sin pares, no hay efecto.
    assert.equal(efectoForjadas([ex('a', 50), ex('a', 90, con)])[0]!.util, false);
    assert.equal(efectoForjadas([0, 1, 2, 3, 4].flatMap((i) => [ex(`t${i}`, 70), ex(`t${i}`, i < 2 ? 40 : 90, con)]))[0]!.util, false);
    assert.deepEqual(efectoForjadas([ex('a', 50)]), []);
  });

  it('examen: cada tarea se hace sin skill y, si hay forjadas para su dominio, otra vez con ellas; la skill llega al alumno y no al tutor', async () => {
    const repo = mkdtempSync(join(dir, 'repo-'));
    const git = (...a: string[]) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true });
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@k.local'); git('config', 'user.name', 't');
    writeFileSync(join(repo, 'a.txt'), 'uno\n'); git('add', '-A'); git('commit', '-q', '-m', 'base');
    writeFileSync(join(repo, 'b.ts'), 'export const x = 1;\n'); git('add', '-A'); git('commit', '-q', '-m', 'tarea', '-m', 'Karajan-Tarea: t-uno');
    const prompts: { alumno: boolean; texto: string }[] = [];
    const ejecutor: Ejecutor = async (p, modelo, instruccion, { cwd }) => {
      const esAlumno = p.nombre === 'alumno-falso';
      prompts.push({ alumno: esAlumno, texto: instruccion });
      if (esAlumno) { writeFileSync(join(cwd, 'b.ts'), 'export const y = 2;\n'); return { salida: 'hecho', error: null, latenciaMs: 1, modelo }; }
      return { salida: '{"cumple":90,"equivalencia":90,"regresiones":false,"motivo":"ok"}', error: null, latenciaMs: 1, modelo };
    };
    const falso = (nombre: string): Proveedor => ({ nombre, etiqueta: nombre, binario: nombre, gratis: true, modelos: {}, args: () => [], login: '' });
    const skill: SkillForjada = { id: 'skill-backend', version: 1, dominios: ['backend'], instrucciones: 'PASO-FORJADO: valida la entrada primero.' };
    let previos: ExamenAnonimo[] = [];
    const ctx = (forjadas: SkillForjada[]): ContextoTutoria => ({
      tareas: async () => [], calibraciones: () => [],
      tareasReales: async () => [{ id: 't-uno', estado: 'completada', prompt: 'haz algo en el backend', actualizada: 1 }] as never,
      hash: (id) => `h-${id}`, repos: () => [repo], alumno: () => ({ agente: { proveedor: falso('alumno-falso'), modelo: 'm' } }), tutor: () => ({ agente: { proveedor: falso('tutor-falso'), modelo: 't' } }),
      puertos: () => ({ ejecutor, planificar: () => ({ dominio: 'backend', nivel: 2, subtareas: [{ nombre: 'hacerlo', validacion: 'que funcione', skills: [] }] }), instaladas: () => new Set(), textoSkill: () => null }),
      previos: () => previos, forjadas: () => forjadas, autorizado: () => true, maxPorEjecucion: () => 5,
    });
    const examen = laboratorioTutoria.escenarios.find((e) => e.id === 'examen')!;
    const nuevosDe = async (c: ContextoTutoria) => ((await examen.ejecutar(c)).detalle as { nuevos: ExamenAnonimo[] }).nuevos;

    const r1 = await examen.ejecutar(ctx([skill]));
    const nuevos = (r1.detalle as { nuevos: ExamenAnonimo[] }).nuevos;
    assert.deepEqual(nuevos.map((e) => e.forjadas ?? null), [null, ['skill-backend@v1']], 'primero sin skill, luego con ella');
    assert.equal(prompts.filter((p) => p.alumno && p.texto.includes('PASO-FORJADO')).length, 1, 'solo el examen «con skill» la lleva');
    assert.ok(!prompts.filter((p) => !p.alumno).some((p) => p.texto.includes('PASO-FORJADO')), 'el tutor no recibe la skill');
    assert.equal(r1.metricas['skills_forjadas'], 1);
    assert.equal(r1.metricas['pares_forjada'], 1);
    assert.equal(git('worktree', 'list').stdout.trim().split('\n').length, 1, 'sin worktrees sobrantes');

    // Con lo ya hecho no se repite nada; una skill de otro dominio no examina; una versión nueva de la skill sí.
    previos = nuevos;
    assert.equal((await nuevosDe(ctx([skill]))).length, 0);
    assert.equal((await nuevosDe(ctx([{ ...skill, dominios: ['frontend'] }]))).length, 0);
    assert.deepEqual((await nuevosDe(ctx([{ ...skill, version: 2 }]))).map((e) => e.forjadas), [['skill-backend@v2']]);
    // Sin skills forjadas, el examen es el de siempre.
    previos = [];
    assert.deepEqual((await nuevosDe(ctx([]))).map((e) => e.forjadas ?? null), [null]);
  });
});
