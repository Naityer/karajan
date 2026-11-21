import assert from 'node:assert/strict';
import test from 'node:test';

import { Azar, banda, detectarNecesidades, MIN_MUESTRAS, proponerGeneracion, wilson, type Muestra } from '../src/evolucion';
import { presetBase } from '../src/perfil-base';
import { areasDeTarea, ranking, SCORING_POR_DEFECTO, type EntidadConFicha } from '../src/puntuacion';

const perfil = () => presetBase();
const ents = () => perfil().entities as EntidadConFicha[];
const ID = 'base-2026-11-12';

// Valores de paridad calculados con app/routing/puntuacion.py sobre el mismo perfil base y la misma tarea.
test('puntuación: mismas cifras que Python y Opus/Fable vetados por duración', () => {
  const tarea = { complejidad: 3, criterios: { ambiguity: 1, context_required: 2, reasoning_depth: 3, autonomy_required: 4, operational_risk: 1, validation_difficulty: 2 }, areas: ['frontend', 'grafico'] };
  const r = ranking(ents(), tarea, perfil()['scoring'] as never);
  const puntos = Object.fromEntries(r.map((x) => [x.entidad.id, x.puntos]));
  assert.deepEqual(r.slice(0, 3).map((x) => x.entidad.id), ['base-sonnet', 'base-terra', 'base-astra']);
  assert.equal(puntos['base-sonnet'], 70.66);
  assert.equal(puntos['base-terra'], 53.33);
  assert.equal(puntos['base-astra'], 49.66);
  assert.equal(puntos['base-opus'], undefined);
  assert.equal(puntos['base-fable'], undefined);
});

test('áreas de la tarea: mismas que Python', () => {
  assert.deepEqual(areasDeTarea('Diseña la interfaz y redacta un resumen académico del vídeo', ['programming']), ['frontend', 'grafico', 'redaccion', 'academico', 'programming']);
});

test('generador congruencial: misma secuencia que Python (semilla 7)', () => {
  const a = new Azar(7);
  assert.deepEqual([a.random(), a.random(), a.random()].map((x) => Math.round(x * 1e6) / 1e6), [0.238781, 0.913493, 0.612492]);
});

test('reparto continuo: sube de Haiku a Sonnet a Opus con la puntuación', () => {
  const orden = ['base-haiku', 'base-sonnet', 'base-opus', 'base-fable'];
  const elegir = (s: number) => ranking(ents(), { complejidad: s, criterios: { ambiguity: 1, context_required: 0, reasoning_depth: 1, autonomy_required: 3, operational_risk: 1, validation_difficulty: 1 }, areas: ['frontend'] }, SCORING_POR_DEFECTO)[0]!.entidad.id;
  const elegidos = [1.0, 1.8, 2.4, 3.0, 4.0, 4.6].map(elegir);
  const pos = elegidos.filter((e) => orden.includes(e)).map((e) => orden.indexOf(e));
  assert.deepEqual(pos, [...pos].sort((x, y) => x - y), elegidos.join());
  assert.notEqual(elegidos[0], elegidos.at(-1));
});

const muestras = (id: string, n: number, exitos: number, area = 'redaccion', complejidad = 1.2, perfilId = ID): Muestra[] => {
  const e = ents().find((x) => x.id === id)!;
  return Array.from({ length: n }, (_, i) => ({ profile_id: perfilId, clave: [e.provider!, e.model!] as [string, string], complejidad, areas: [area], ok: i < exitos, coste: 0, latencia_ms: 0 }));
};

test('sin muestras suficientes no hay necesidad ni hijos', () => {
  const ms = muestras('base-luna', MIN_MUESTRAS - 1, 0);
  assert.deepEqual(detectarNecesidades(perfil(), ms), []);
  assert.deepEqual(proponerGeneracion([perfil()], ID, ms), []);
  assert.deepEqual(wilson(0, 0), [0, 1]);
  assert.equal(banda(2.4), 2);
});

test('un fracaso demostrado muta un solo gen, deja linaje y es igual que en Python', () => {
  const hijos = proponerGeneracion([perfil()], ID, muestras('base-luna', 20, 8), 7);
  assert.equal(hijos.length, 1);
  const h = hijos[0]! as unknown as { id: string; origin: string; generation: number; parents: string[]; mutation_note: string; entities: EntidadConFicha[] };
  assert.equal(h.id, `${ID}-g1`);
  assert.equal(h.origin, 'mutacion');
  assert.equal(h.generation, 1);
  assert.deepEqual(h.parents, [ID]);
  assert.equal(h.mutation_note, 'área «redaccion»: 40 % de éxito (IC95 22–61 %) en 20 ejecuciones con base-luna. Cambio: afinidad «redaccion» de base-luna: 0.95→0.76.');
  const otros = (ps: EntidadConFicha[]) => JSON.stringify(ps.filter((e) => e.id !== 'base-luna').map((e) => e.aptitud));
  assert.equal(otros(h.entities), otros(ents()));
});

test('el cruce hereda la ficha del padre con mejor evidencia y nunca cambia el perfil por defecto', () => {
  const otro = presetBase('otro-perfil');
  (otro.entities as EntidadConFicha[]).find((e) => e.id === 'base-luna')!.aptitud!.afinidad_dominio['redaccion'] = 0.5;
  const ms = [...muestras('base-luna', 20, 8), ...muestras('base-luna', 20, 19, 'redaccion', 1.2, 'otro-perfil')];
  const hijos = proponerGeneracion([perfil(), otro], ID, ms) as unknown as { origin: string; parents: string[]; entities: EntidadConFicha[] }[];
  const cruce = hijos.find((h) => h.origin === 'cruce')!;
  assert.equal(cruce.entities.find((e) => e.id === 'base-luna')!.aptitud!.afinidad_dominio['redaccion'], 0.5);
  assert.deepEqual([...cruce.parents].sort(), [ID, 'otro-perfil']);
});
