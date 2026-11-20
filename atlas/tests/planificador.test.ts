import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { planificar, sugerirSubagente, type ContextoPlanificador, type PlanEjecucion, type TareaClasificada } from '../src/planificador';
import { validarCombinacion } from '../src/planificador-modos';
import { anotarEvento, CONFIG_POR_DEFECTO, guardarChecker, guardarConfig, guardarPlan, leerConfig, leerPlan, normalizarConfig } from '../src/planificador-registro';
import { casosContrato, laboratorioPlanificador } from '../src/lab/planificador.lab';

const ctx = (extra: Partial<ContextoPlanificador> = {}): ContextoPlanificador => ({ config: CONFIG_POR_DEFECTO, ahora: () => new Date('2026-11-04T12:00:00Z'), ...extra });
const tarea = (nivel = 3, n = 4, dominio = ['programming']): TareaClasificada => ({ nivel, dominio, subtareas: Array.from({ length: n }, (_, i) => ({ nombre: `Parte ${i + 1}`, validacion: `ok ${i + 1}`, complejidad: i + 1 })) });
const plan = (solicitud: Parameters<typeof planificar>[0]['solicitud'], t = tarea(), c = ctx(), agente = 'claude') => planificar({ solicitud, tarea: t, agente }, c);
const subs = (p: PlanEjecucion) => Object.values(p.actores).filter((a) => a.id.startsWith('sub'));

describe('validación de modos', () => {
  it('acepta los modos base y sus combinaciones válidas', () => {
    for (const modo of ['classic', 'single-agent', 'master-slave', 'co-work', 'auto']) assert.equal(validarCombinacion({ modo }).ok, true, modo);
    for (const [modo, modificadores] of [['master-slave', ['milestone', 'checker']], ['classic', ['lazy-agent', 'milestone']], ['co-work', ['milestone', 'checker']], ['auto', ['lazy-agent', 'checker', 'milestone']]] as const) assert.equal(validarCombinacion({ modo, modificadores: [...modificadores] }).ok, true, `${modo}+${modificadores}`);
  });
  it('rechaza lo incompatible explicando el motivo', () => {
    const v = validarCombinacion({ modo: 'co-work', modificadores: ['lazy-agent'] });
    assert.equal(v.ok, false);
    assert.match(v.errores[0]!, /lazy-agent/);
    assert.equal(validarCombinacion({ modo: 'classic', subagentes: [{}] }).ok, false);
    assert.equal(validarCombinacion({ modo: 'single-agent', subagentes: [{}, {}] }).ok, false);
    // El principal es el primer especialista: con un solo subagente ya son dos.
    assert.equal(validarCombinacion({ modo: 'co-work', subagentes: [{}] }).ok, true);
    assert.equal(validarCombinacion({ modo: 'turbo' }).ok, false);
  });
  it('un modificador puesto como modo pasa a ser modificador de classic, con aviso', () => {
    const v = validarCombinacion({ modo: 'milestone' });
    assert.deepEqual([v.ok, v.modo, v.modificadores], [true, 'classic', ['milestone']]);
    assert.ok(v.avisos.length);
  });
});

describe('planes por modo', () => {
  it('classic: un solo agente ejecuta la tarea completa', () => {
    const p = plan({ modo: 'classic' });
    assert.deepEqual(Object.keys(p.actores), ['principal']);
    assert.equal(p.pasos.length, 1);
    assert.equal(p.pasos[0]!.entregable, 'Tarea completa en el repositorio');
  });
  it('master-slave: principal superior y subagentes de la misma familia; el principal integra al final', () => {
    const p = plan({ modo: 'master-slave' }, tarea(4));
    assert.equal(p.actores['principal']!.nivel, 'superior');
    assert.ok(subs(p).length >= 1 && subs(p).every((a) => a.agente === 'claude' && a.nivel === 'medio'));
    assert.equal(p.pasos.at(-1)!.tipo, 'integracion');
    assert.equal(p.pasos.at(-1)!.actor, 'principal');
  });
  it('master-slave respeta el principal y los subagentes configurados, con su modelo', () => {
    const p = plan({ modo: 'master-slave', principal: { agente: 'codex', modelo: 'gpt-x' }, subagentes: [{ agente: 'gemini', nivel: 'bajo' }, { agente: 'codex', modelo: 'mini' }] });
    assert.equal(p.actores['principal']!.agente, 'codex');
    assert.equal(p.actores['principal']!.modelo, 'gpt-x');
    assert.deepEqual(subs(p).map((a) => [a.agente, a.nivel, a.modelo]), [['gemini', 'bajo', null], ['codex', 'medio', 'mini']]);
  });
  it('sugerirSubagente prioriza la familia del principal y avisa cuando no la hay', () => {
    assert.equal(sugerirSubagente('codex', ctx()).agente, 'codex');
    const sinCodex = ctx({ disponible: (a) => a !== 'codex' });
    const s = sugerirSubagente('codex', sinCodex);
    assert.notEqual(s.agente, 'codex');
    assert.match(s.aviso!, /familia codex/);
  });
  it('single-agent: como mucho un subagente barato y solo para algo complementario y sencillo', () => {
    const p = plan({ modo: 'single-agent' }, { nivel: 3, dominio: ['programming'], subtareas: [{ nombre: 'Implementar', complejidad: 3 }, { nombre: 'Añadir pruebas', complejidad: 1 }] });
    assert.equal(subs(p).length, 1);
    assert.deepEqual([subs(p)[0]!.nivel, subs(p)[0]!.esfuerzo], ['bajo', 'bajo']);
    assert.equal(p.pasos.find((x) => x.titulo === 'Añadir pruebas')!.actor, 'sub1');
    assert.equal(subs(plan({ modo: 'single-agent' }, { nivel: 3, dominio: ['x'], subtareas: [{ nombre: 'Diseñar' }, { nombre: 'Construir' }] })).length, 0);
  });
  it('co-work: especialistas por ámbito sobre un repositorio común y jefe frontera de 5 minutos bajo demanda', () => {
    const p = plan({ modo: 'co-work' }, tarea(4));
    const esp = Object.values(p.actores).filter((a) => a.id !== 'jefe');
    assert.ok(esp.length >= 2 && esp.every((a) => a.ambito));
    assert.equal(p.repoComun, true);
    assert.equal(p.jefe!.intervencionMin, 5);
    assert.deepEqual(p.jefe!.candidatos, ['opus', 'fable', 'asura', 'sol']);
    const j = p.pasos.find((x) => x.tipo === 'jefe')!;
    assert.equal(j.bajoDemanda, true);
    assert.equal(p.pasos.filter((x) => x.tipo === 'trabajo').every((x) => x.depende.length === 0), true, 'los especialistas trabajan en paralelo');
  });
  it('milestone: hitos secuenciales con síntesis entre ellos y cada hito espera al anterior', () => {
    const p = plan({ modo: 'classic', modificadores: ['milestone'] }, tarea(4, 6));
    assert.ok(p.hitos.length >= 2 && p.hitos.every((h) => h.objetivo && h.entregable && h.validacion));
    assert.equal(p.pasos.filter((x) => x.tipo === 'sintesis').length, p.hitos.length - 1);
    for (let i = 1; i < p.hitos.length; i++) {
      const primero = p.pasos.find((x) => x.id === p.hitos[i]!.pasos[0])!, ultimoPrevio = p.hitos[i - 1]!.pasos.at(-1)!;
      assert.ok(primero.depende.includes(ultimoPrevio), `hito ${i + 1} no espera a ${ultimoPrevio}`);
    }
  });
  it('milestone con una sola tarea la trocea en entender, implementar y verificar', () => {
    const p = plan({ modo: 'classic', modificadores: ['milestone'] }, { nivel: 2, dominio: ['x'], subtareas: [] });
    assert.deepEqual(p.pasos.filter((x) => x.tipo === 'trabajo').map((x) => x.titulo), ['Entender y diseñar', 'Implementar', 'Verificar']);
  });
  it('checker: último paso, actor ligero y criterios de revisión; combinable con cualquier modo', () => {
    for (const modo of ['classic', 'single-agent', 'master-slave', 'co-work'] as const) {
      const p = plan({ modo, modificadores: ['checker'] }, tarea(4));
      assert.equal(p.pasos.at(-1)!.tipo, 'checker', modo);
      assert.deepEqual([p.actores['checker']!.nivel, p.actores['checker']!.esfuerzo], ['bajo', 'bajo']);
      assert.deepEqual(p.checker!.criterios, ['errores', 'bugs', 'trabajo pendiente']);
    }
    assert.equal(plan({ modo: 'classic', checker: { agente: 'gemini' } }).actores['checker']!.agente, 'gemini');
  });
  it('lazy-agent usa nivel bajo, también en los subagentes de master-slave (el principal sigue siendo superior)', () => {
    assert.equal(plan({ modo: 'classic', modificadores: ['lazy-agent'] }).actores['principal']!.nivel, 'bajo');
    const p = plan({ modo: 'master-slave', modificadores: ['lazy-agent'] }, tarea(4));
    assert.equal(p.actores['principal']!.nivel, 'superior');
    assert.ok(subs(p).every((a) => a.nivel === 'bajo'));
  });
  it('todo plan es coherente: dependencias que existen, actores que existen y sin ciclos', () => {
    const fallos = casosContrato(CONFIG_POR_DEFECTO).filter((c) => !c.ok);
    assert.deepEqual(fallos, []);
  });
  it('un plan rechazado no tiene pasos y lo dice', () => {
    const p = plan({ modo: 'co-work', modificadores: ['lazy-agent'] });
    assert.deepEqual([p.pasos.length, p.errores.length > 0], [0, true]);
    assert.match(p.motivo, /rechazado/i);
  });
  it('un agente no disponible se sustituye con aviso y sin agentes activos el plan se rechaza', () => {
    const p = plan({ modo: 'classic' }, tarea(), ctx({ disponible: (a) => a !== 'claude' }));
    assert.notEqual(p.actores['principal']!.agente, 'claude');
    assert.ok(p.avisos.some((a) => /no está activo/.test(a)));
    assert.ok(plan({ modo: 'classic' }, tarea(), ctx({ disponible: () => false })).errores.length);
  });
});

describe('auto', () => {
  it('crea siempre un plan con el agente seleccionado y elige un formato concreto con la comparación y el motivo', () => {
    const p = plan({ modo: 'auto' }, tarea(3), ctx(), 'codex');
    assert.equal(p.solicitado, 'auto');
    assert.notEqual(p.modo, 'auto');
    assert.equal(p.actores['principal']!.agente, 'codex');
    assert.ok(p.alternativas.length >= 3 && p.alternativas[0]!.puntuacion <= p.alternativas[1]!.puntuacion);
    assert.match(p.motivo, /Auto eligió/);
    assert.ok(p.pasos.length > 0);
  });
  it('sin métricas observadas lo dice: usa priors y avisa de que es una estimación', () => {
    const p = plan({ modo: 'auto' });
    assert.deepEqual([p.metricas.coste, p.metricas.acierto], ['prior', 'prior']);
    assert.ok(p.avisos.some((a) => /priors/.test(a)));
  });
  it('con métricas observadas las usa y las cita', () => {
    const p = plan({ modo: 'auto' }, tarea(3), ctx({ coste: () => ({ pct: 2, fuente: 'observado' }), acierto: () => ({ valor: 0.9, n: 30 }) }));
    assert.deepEqual([p.metricas.coste, p.metricas.acierto], ['observado', 'observado']);
    assert.match(p.motivo, /coste observado, acierto observado/);
    assert.ok(!p.avisos.some((a) => /priors/.test(a)));
  });
  it('un acierto observado bajo hace más caro el riesgo del agente que falla', () => {
    const fallon = plan({ modo: 'classic' }, tarea(3), ctx({ acierto: () => ({ valor: 0.3, n: 50 }) }));
    const fiable = plan({ modo: 'classic' }, tarea(3), ctx({ acierto: () => ({ valor: 0.95, n: 50 }) }));
    assert.ok(fallon.metricas.estimacion!.riesgo > fiable.metricas.estimacion!.riesgo);
  });
  it('con la cuota frenada pasa a lazy-agent y nunca cuesta más; la tarea compleja añade hitos y sugiere checker', () => {
    for (const nivel of [1, 2, 3, 4, 5]) {
      const normal = plan({ modo: 'auto' }, tarea(nivel), ctx({ cuota: () => ({ modo: 'normal' }) }));
      const frenada = plan({ modo: 'auto' }, tarea(nivel), ctx({ cuota: () => ({ modo: 'frenado' }) }));
      assert.ok(frenada.modificadores.includes('lazy-agent'), `nivel ${nivel}`);
      assert.ok(frenada.metricas.estimacion!.coste <= normal.metricas.estimacion!.coste + 1e-9, `nivel ${nivel}`);
    }
    const alto = plan({ modo: 'auto' }, tarea(5));
    assert.ok(alto.modificadores.includes('milestone'));
    assert.ok(alto.avisos.some((a) => /checker/.test(a)));
    assert.ok(!alto.modificadores.includes('checker'), 'auto sugiere el checker pero no lo añade solo');
  });
  it('conserva los modificadores pedidos y no elige co-work con lazy-agent', () => {
    const p = plan({ modo: 'auto', modificadores: ['lazy-agent', 'checker'] }, tarea(5));
    assert.ok(p.modificadores.includes('checker') && p.modificadores.includes('lazy-agent'));
    assert.ok(p.alternativas.every((a) => a.modo !== 'co-work'));
    assert.equal(p.pasos.at(-1)!.tipo, 'checker');
  });
});

describe('registro y configuración', () => {
  const dir = mkdtempSync(join(tmpdir(), 'karajan-planificador-'));
  it('normaliza la configuración sin lanzar nunca', () => {
    for (const basura of [null, 3, 'x', [], { pesos: 'x', jefe: { intervencionMin: 'mucho' }, agentes: { 'MAL ID': {} } }]) {
      const c = normalizarConfig(basura);
      assert.equal(c.jefe.intervencionMin, 5);
      assert.ok(c.agentes['claude']);
    }
    assert.equal(normalizarConfig({ jefe: { intervencionMin: 999 } }).jefe.intervencionMin, 30);
  });
  it('guardar config mezcla con la existente y persiste', () => {
    const ruta = join(dir, 'cfg.json');
    guardarConfig(ruta, { jefe: { intervencionMin: 8 } });
    const c = guardarConfig(ruta, { maxSubagentes: 2, agentes: { codex: { activo: false } } });
    assert.deepEqual([c.jefe.intervencionMin, c.maxSubagentes, c.agentes['codex']!.activo], [8, 2, false]);
    assert.deepEqual(leerConfig(ruta), c);
  });
  it('guarda el plan, anota eventos y rechaza estados desconocidos', () => {
    const ruta = join(dir, 'planes.json');
    const p = plan({ modo: 'master-slave', modificadores: ['checker'] });
    const r = guardarPlan(ruta, 'tsk1', p);
    assert.equal(r.estado, 'planificado');
    assert.equal(anotarEvento(ruta, 'tsk1', { tipo: 'hito', detalle: 'hito 1 validado', estado: 'ejecutando' })!.estado, 'ejecutando');
    assert.throws(() => anotarEvento(ruta, 'tsk1', { tipo: 'estado', detalle: 'x', estado: 'genial' }), /estado/);
    assert.equal(anotarEvento(ruta, 'no-existe', { tipo: 'estado', detalle: 'x' }), null);
    assert.equal(leerPlan(ruta, 'tsk1')!.eventos.length, 2);
  });
  it('un plan rechazado se guarda como fallido, no como planificado', () => {
    const ruta = join(dir, 'planes2.json');
    assert.equal(guardarPlan(ruta, 'tsk2', plan({ modo: 'co-work', modificadores: ['lazy-agent'] })).estado, 'fallido');
  });
  it('el checker guarda hallazgos y un checker fallido NO cuenta como limpio y bloquea el plan', () => {
    const ruta = join(dir, 'planes3.json');
    guardarPlan(ruta, 'tsk3', plan({ modo: 'classic', modificadores: ['checker'] }));
    const con = guardarChecker(ruta, 'tsk3', { estado: 'limpio', hallazgos: [{ severidad: 'alta', titulo: 'Falta validar la entrada' }, { titulo: '' }, 'basura'] })!;
    assert.deepEqual([con.checker!.estado, con.checker!.hallazgos.length], ['hallazgos', 1]);
    const fallo = guardarChecker(ruta, 'tsk3', { estado: 'fallido', resumen: 'sin tokens' })!;
    assert.deepEqual([fallo.checker!.estado, fallo.estado], ['fallido', 'bloqueado']);
    assert.equal(fallo.eventos.at(-1)!.tipo, 'fallo');
    assert.equal(guardarChecker(ruta, 'tsk3', { estado: 'limpio' })!.checker!.estado, 'limpio');
    assert.equal(guardarChecker(ruta, 'nada', { estado: 'limpio' }), null);
  });
  it('rmSync', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temporal */ } });
});

describe('laboratorio del planificador', () => {
  it('sus dos escenarios pasan sin hallazgos', async () => {
    for (const e of laboratorioPlanificador.escenarios) {
      const r = await e.ejecutar({ config: () => CONFIG_POR_DEFECTO, tareas: async () => [], calibraciones: () => [] });
      assert.deepEqual(r.hallazgos, [], `${e.id}: ${JSON.stringify(r.hallazgos)}`);
      assert.equal(r.suficiente, true, e.id);
    }
  });
});
