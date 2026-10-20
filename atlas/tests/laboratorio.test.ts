import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import { AtlasDev } from '../src/atlas-dev';
import { Biblioteca } from '../src/biblioteca';
import { Delegador } from '../src/delegar';
import { anonimizar, ejecutarLaboratorio, RegistroLab, wilson, type ContextoLab, type TareaAnonima } from '../src/laboratorio';
import { agenteDelPlan, laboratorioDelegador, type ContextoDelegador } from '../src/lab/delegador.lab';
import { casosDe, laboratorioSelector, medir, type ContextoSelector } from '../src/lab/selector.lab';
import { Almacen } from '../src/almacen';
import { configDesde } from '../src/heuristica';
import { Pasarela } from '../src/pasarela-borradores';
import { Perfiles, perfilPorDefecto } from '../src/perfiles';
import { presetDominio } from '../src/reglas';
import { PESOS_SELECTOR, type SkillDisponible } from '../src/skills-seleccion';
import type { TareaAtlas } from '../src/atlas-dev';
import { atlasFalso } from './ayuda-atlas';

const dir = mkdtempSync(join(tmpdir(), 'karajan-lab-'));
const abiertas: { cerrar(): void }[] = [];
after(() => { for (const a of abiertas) a.cerrar(); rmSync(dir, { recursive: true, force: true }); });
const HORA = 3_600_000;
const tarea = (id: string, prompt: string, agente: string, estado = 'completada', creada = 0, extra: Partial<TareaAtlas> = {}): TareaAtlas =>
  ({ id, titulo: `secreto ${id}`, estado, agente: agente === 'auto' ? 'codex' : agente, prompt, creada, actualizada: creada, hoja: { agente, skills: [] }, ...extra });

describe('motor del laboratorio', () => {
  it('anonimiza: sin id ni título, «auto» no es una elección humana, fuera las propuestas de Karajan, y marca el re-trabajo', () => {
    const t = anonimizar([
      tarea('a1', 'Arregla el login de atlas/src/auth.ts que falla', 'claude', 'completada', 0),
      tarea('a2', 'Sigue fallando el login de atlas/src/auth.ts, arréglalo otra vez', 'claude', 'completada', HORA),
      tarea('a3', 'Escribe el informe trimestral', 'auto', 'completada', 2 * HORA),
      tarea('a4', '# x\n\nOrigen: karajan:selector:y\n', 'auto', 'borrador', 3 * HORA),
      tarea('a5', 'Pendiente de hacer', 'codex', 'encolada', 4 * HORA),
    ], 'sal');
    assert.equal(t.length, 4);
    assert.equal(JSON.stringify(t).includes('secreto'), false);
    assert.equal(JSON.stringify(t).includes('"a1"'), false);
    assert.deepEqual(t.map((x) => x.agenteHumano), ['claude-cli', 'claude-cli', null, 'codex']);
    assert.equal(t[0]!.retrabajo, true);
    assert.equal(t[0]!.exito, false);
    assert.equal(t[1]!.exito, true);
    assert.equal(t[3]!.exito, null);
    assert.notEqual(anonimizar([tarea('a1', 'x', 'claude')], 'otra')[0]!.hash, t[0]!.hash);
  });

  it('Wilson: estrecho con mucha muestra, ancho con poca', () => {
    const [a, b] = wilson(5, 10), [c, d] = wilson(500, 1000);
    assert.ok(a < 0.25 && b > 0.75);
    assert.ok(c > 0.46 && d < 0.54);
    assert.deepEqual(wilson(0, 0), [0, 1]);
  });

  it('guarda cada escenario (también los que fallan) y propone sus hallazgos por la pasarela', async () => {
    const registro = new RegistroLab(join(dir, 'lab.db'));
    const a = atlasFalso();
    const pasarela = new Pasarela(new AtlasDev('http://atlas', a.fetch), join(dir, 'b.json'));
    const informe = await ejecutarLaboratorio({ id: 'prueba', version: '1', laboratorio: { escenarios: [
      { id: 'bien', tipo: 'contrato', descripcion: '', ejecutar: () => ({ muestra: 3, suficiente: true, metricas: { m: 0.5 }, hallazgos: [{ clave: 'k', severidad: 'media', titulo: 'T', evidencia: 'E', propuesta: 'P' }] }) },
      { id: 'mal', tipo: 'replay', descripcion: '', ejecutar: () => { throw new Error('se rompió'); } },
    ] } }, {} as ContextoLab, registro, { pasarela });
    assert.equal(informe.escenarios[0]!.propuestas[0]!.accion, 'creada');
    assert.equal(informe.escenarios[1]!.error, 'se rompió');
    const guardadas = registro.ejecuciones('prueba');
    assert.deepEqual(guardadas.map((e) => e.escenario).sort(), ['bien', 'mal']);
    assert.deepEqual(guardadas.find((e) => e.escenario === 'bien')!.metricas, { m: 0.5 });
    registro.cerrar();
  });
});

describe('biblioteca (resources.db en solo lectura)', () => {
  it('distingue estrellas propias de heredadas y busca sin FTS', () => {
    const ruta = join(dir, 'resources.db');
    const db = new DatabaseSync(ruta);
    db.exec(`CREATE TABLE resources (id TEXT PRIMARY KEY, slug TEXT, name TEXT, kind TEXT, repo_url TEXT, summary TEXT, capabilities_json TEXT, metadata_json TEXT, parent_resource_id TEXT, source_url TEXT, index_status TEXT DEFAULT 'active')`);
    const ins = db.prepare('INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('p', 'coleccion', 'coleccion', 'capability', 'https://github.com/x/coleccion', 'Colección de skills', '[]', JSON.stringify({ github_stars: 9000, decision_taxonomy: { group_id: 'g1' } }), null, null, 'active');
    ins.run('h', 'coleccion--tdd', 'tdd', 'skill', null, 'Test driven development', '[]', JSON.stringify({ github_stars: 9000 }), 'p', 'https://github.com/x/coleccion/tree/main/tdd', 'active');
    ins.run('s', 'ponytail', 'ponytail', 'skill', 'https://github.com/y/ponytail', 'Minimal code', '["eficiencia"]', JSON.stringify({ github_stars: 120 }), null, null, 'active');
    db.close();
    const b = new Biblioteca(ruta);
    assert.deepEqual([b.fichaDe('tdd')!.heredadas, b.fichaDe('tdd')!.repo_url], [true, 'https://github.com/x/coleccion/tree/main/tdd']);
    assert.deepEqual([b.fichaDe('ponytail')!.heredadas, b.fichaDe('ponytail')!.estrellas], [false, 120]);
    assert.deepEqual(b.buscar('driven').map((f) => f.nombre), ['tdd']);
    assert.equal(new Biblioteca(join(dir, 'no.db')).disponible, false);
    b.cerrar();
  });
});

/** Un delegador de laboratorio sobre el perfil «por dominio», con todos los agentes disponibles. */
function contextoDelegador(tareas: TareaAtlas[], perfil = presetDominio()): ContextoDelegador {
  const d = mkdtempSync(join(dir, 'del-'));
  const perfiles = new Perfiles(join(d, 'layout.json'));
  perfiles.guardar({ profiles: [perfil], active_profile_id: perfil.id, default_profile_id: perfil.id });
  const delegador = new Delegador({
    almacen: (() => { const a = new Almacen(join(d, 'tareas.db')); abiertas.push(a); return a; })(), perfiles, config: () => configDesde(null), raiz: d, skillsDisponibles: () => [], limites: () => null,
    disponible: (p) => ({ nombre: p.nombre, etiqueta: p.nombre, gratis: false, disponible: true, ruta: null, motivo: null, login: '' }),
    ejecutor: () => { throw new Error('no'); },
  });
  const anon = anonimizar(tareas, 'sal');
  return { tareas: async () => anon, calibraciones: () => [], perfil: () => perfilPorDefecto(perfiles.leer()), planificar: (p) => delegador.planificar(p) };
}

describe('laboratorio del delegador', () => {
  const lab = (id: string) => laboratorioDelegador.escenarios.find((e) => e.id === id)!;

  it('fidelidad: con el perfil por dominio cada decisión es trazable; detecta reglas tapadas', async () => {
    const ctx = contextoDelegador([tarea('1', 'Diseña la interfaz del dashboard en React con animaciones', 'claude'), tarea('2', 'Crea un endpoint de API en el servidor', 'codex')]);
    const r = await lab('fidelidad').ejecutar(ctx);
    assert.equal(r.metricas['trazabilidad'], 1);
    assert.equal(r.hallazgos.some((h) => h.clave === 'no-trazable'), false);
    const p = presetDominio();
    p.rules = [{ id: 'todo', entity_id: 'dominio-codex' }, ...(p.rules ?? [])];
    const r2 = await lab('fidelidad').ejecutar(contextoDelegador([tarea('1', 'hola', 'codex')], p));
    assert.equal(r2.hallazgos.find((h) => h.clave === 'reglas-tapadas')?.severidad, 'media');
  });

  it('concordancia a ciegas: matriz persona × Karajan', async () => {
    const ctx = contextoDelegador([tarea('1', 'Crea un endpoint de API en el servidor', 'codex'), tarea('2', 'Crea un endpoint de API REST en el servidor', 'claude'), tarea('3', 'x', 'auto')]);
    const r = await lab('concordancia').ejecutar(ctx);
    assert.equal(r.muestra, 2);
    assert.equal(r.metricas['concordancia'], 0.5);
    assert.equal(r.suficiente, false);
    assert.deepEqual((r.detalle as { matriz_humano_vs_karajan: object }).matriz_humano_vs_karajan, { codex: { codex: 1 }, 'claude-cli': { codex: 1 } });
  });

  it('adecuación: si la persona acierta donde el perfil la contradice, propone un perfil nuevo válido', async () => {
    // 12 tareas de backend que el perfil manda a Codex y la persona dio a Claude, todas bien.
    const tareas = Array.from({ length: 12 }, (_, i) => tarea(`b${i}`, `Crea el endpoint ${['usuarios', 'pedidos', 'facturas', 'clientes', 'stock', 'rutas', 'envíos', 'pagos', 'avisos', 'notas', 'citas', 'turnos'][i]} de la API`, 'claude', 'completada', i * 48 * HORA));
    const ctx = contextoDelegador(tareas);
    assert.equal(agenteDelPlan(ctx.planificar(tareas[0]!.prompt!)), 'codex');
    const r = await lab('adecuacion').ejecutar(ctx);
    const h = r.hallazgos.find((x) => x.clave === 'perfil-inadecuado');
    assert.ok(h, JSON.stringify(r.detalle));
    assert.match(h.propuesta, /"provider": "claude-cli"|dominio-claude/);
    assert.match(h.propuesta, /ajustado por el laboratorio/);
    // Con pocas tareas no concluye nada.
    const poco = await lab('adecuacion').ejecutar(contextoDelegador(tareas.slice(0, 5)));
    assert.equal(poco.hallazgos.length, 0);
    assert.equal(poco.suficiente, false);
  });

  it('determinismo: el mismo prompt da el mismo plan', async () => {
    const r = await lab('determinismo').ejecutar(contextoDelegador([tarea('1', 'Crea un endpoint', 'codex'), tarea('2', 'Diseña una pantalla', 'auto')]));
    assert.equal(r.metricas['estabilidad'], 1);
    assert.equal(r.hallazgos.length, 0);
  });
});

describe('laboratorio del selector', () => {
  const skills: SkillDisponible[] = [
    { name: 'pdf', description: 'Read and create PDF documents', instaladaEn: ['claude'], enAlmacen: [] },
    { name: 'frontend-builder', description: 'Construye interfaces y componentes', instaladaEn: ['claude'], enAlmacen: [] },
    { name: 'muda', description: '', instaladaEn: ['claude'], enAlmacen: [] },
  ];
  const anon: TareaAnonima[] = anonimizar([
    tarea('1', 'Convierte este pdf en un resumen', 'claude', 'completada', 0, { hoja: { agente: 'claude', skills: ['pdf'] } }),
    tarea('2', 'Haz un dashboard en react', 'codex', 'completada', 0, { hoja: { agente: 'codex', skills: ['docx'] } }),
  ], 'sal');
  const ctx = (cal: ContextoSelector['calibraciones'] = () => []): ContextoSelector => ({ tareas: async () => anon, calibraciones: cal, skills: () => skills, revisadas: () => [] });

  it('la verdad sale de la hoja y la calibración manda sobre ella', async () => {
    const base = await casosDe(ctx());
    assert.deepEqual(base.map((c) => c.verdad[0]).sort(), ['docx', 'pdf']);
    assert.ok(base.every((c) => c.fuente === 'hoja'));
    const h2 = anon[1]!.hash;
    const casos = await casosDe(ctx(() => [{ tarea_hash: h2, componente: 'selector', propuesta: ['frontend-builder'], respuesta: 'si', correccion: [], creada: '' }]));
    assert.deepEqual(casos.find((c) => c.id === h2)!.verdad, ['frontend-builder']);
    assert.equal(casos.find((c) => c.id === h2)!.fuente, 'calibracion');
  });

  it('mide Hit@1, precisión y recall', () => {
    const m = medir([{ id: '1', prompt: 'Convierte este pdf', verdad: ['pdf'], fuente: 'hoja' }, { id: '2', prompt: 'un dashboard en react', verdad: ['docx'], fuente: 'hoja' }], skills, PESOS_SELECTOR);
    assert.equal(m.hit1, 0.5);
    assert.equal(m.recall, 0.5);
  });

  it('nombrar una skill la selecciona; sin descripción se avisa; sin muestra no calibra', async () => {
    const esc = (id: string) => laboratorioSelector.escenarios.find((e) => e.id === id)!;
    const r = await esc('explicitas').ejecutar(ctx());
    assert.equal(r.metricas['no_seleccionables'], 0);
    assert.equal(r.metricas['sin_descripcion'], 1);
    const c = await esc('calibracion').ejecutar(ctx());
    assert.equal(c.suficiente, false);
    assert.equal(c.hallazgos.length, 0);
  });
});
