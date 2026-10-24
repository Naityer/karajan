import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  alternar, combinar, conRetardo, cuerpoCalibracion, estadoDe, formatearEstrellas, mismoConjunto, promptParaConsulta, respuestaDe, sinRepetir, unicas, urlGithub,
  type TarjetaSkill,
} from '../ui/panel-skills-logica';

const tarjeta = (nombre: string, p: Partial<TarjetaSkill> = {}): TarjetaSkill => ({ nombre, puntos: null, descripcion: '', estrellas: null, heredadas: false, repo_url: null, grupo: null, instalada: false, almacen: false, ...p });

describe('panel de skills: lógica pura', () => {
  it('combina la propuesta con lo añadido y lo quitado sin repetir', () => {
    assert.deepEqual(combinar(['a', 'b', 'c'], ['d', 'a'], ['b']), ['a', 'c', 'd']);
    assert.deepEqual(combinar([], [], []), []);
    assert.deepEqual(combinar(['a'], ['x'], ['x']), ['a'], 'lo quitado gana a lo añadido');
    assert.deepEqual(unicas([' a ', 'a', '', 'b']), ['a', 'b']);
  });

  it('alternar añade o quita sin mutar', () => {
    const base = ['a', 'b'];
    assert.deepEqual(alternar(base, 'c'), ['a', 'b', 'c']);
    assert.deepEqual(alternar(base, 'a'), ['b']);
    assert.deepEqual(base, ['a', 'b']);
  });

  it('la respuesta es «sí» solo si el conjunto no cambia (el orden da igual)', () => {
    assert.equal(respuestaDe(['a', 'b'], ['b', 'a']), 'si');
    assert.equal(respuestaDe(['a', 'b'], ['a']), 'no');
    assert.equal(respuestaDe(['a'], ['a', 'z']), 'no');
    assert.equal(respuestaDe([], []), 'si');
    assert.ok(mismoConjunto([], []));
  });

  it('el cuerpo de la calibración lleva la corrección solo con «no»', () => {
    assert.deepEqual(cuerpoCalibracion('t1', ['a'], 'si', ['a']), { tarea: 't1', componente: 'selector', propuesta: ['a'], respuesta: 'si', correccion: [] });
    assert.deepEqual(cuerpoCalibracion('t1', ['a'], 'no', ['b', 'c']), { tarea: 't1', componente: 'selector', propuesta: ['a'], respuesta: 'no', correccion: ['b', 'c'] });
    assert.deepEqual(cuerpoCalibracion('t1', ['a'], 'no', []).correccion, [], '«no» sin skills = ninguna skill hace falta');
  });

  it('solo enlaza repositorios de GitHub por https', () => {
    assert.equal(urlGithub('https://github.com/a/b'), 'https://github.com/a/b');
    assert.equal(urlGithub('http://github.com/a/b'), null);
    assert.equal(urlGithub('https://github.com.evil.example/a'), null);
    assert.equal(urlGithub('javascript:alert(1)'), null);
    assert.equal(urlGithub('no es una url'), null);
    assert.equal(urlGithub(null), null);
  });

  it('formatea estrellas y estado de la tarjeta', () => {
    assert.equal(formatearEstrellas(null), '—');
    assert.equal(formatearEstrellas(850), '850');
    assert.equal(formatearEstrellas(1240), '1,2 mil');
    assert.equal(formatearEstrellas(2_300_000), '2,3 M');
    assert.equal(estadoDe(tarjeta('a', { instalada: true, almacen: true })), 'instalada');
    assert.equal(estadoDe(tarjeta('a', { almacen: true })), 'almacen');
    assert.equal(estadoDe(tarjeta('a', { instalable: true })), 'instalable');
    assert.equal(estadoDe(tarjeta('a')), 'desconocida');
  });

  it('no repite tarjetas entre sugeridas y encontradas', () => {
    const r = sinRepetir([tarjeta('a'), tarjeta('b'), tarjeta('b'), tarjeta('c')], [tarjeta('a')]);
    assert.deepEqual(r.map((t) => t.nombre), ['b', 'c']);
    assert.equal(promptParaConsulta('x'.repeat(5000)).length, 1500);
  });

  it('el debounce llama una vez tras la última llamada y se puede cancelar', () => {
    const tareas: { f: () => void; ms: number; vivo: boolean }[] = [];
    const reloj = {
      set: ((f: () => void, ms: number) => { const t = { f, ms, vivo: true }; tareas.push(t); return t; }) as unknown as typeof setTimeout,
      clear: ((t: { vivo: boolean }) => { t.vivo = false; }) as unknown as typeof clearTimeout,
    };
    const llamadas: string[] = [];
    const d = conRetardo((q: string) => llamadas.push(q), 300, reloj);
    d('p'); d('pd'); d('pdf');
    for (const t of tareas) if (t.vivo) { t.vivo = false; t.f(); }
    assert.deepEqual(llamadas, ['pdf']);
    assert.equal(tareas[0]!.ms, 300);
    d('x'); d.cancelar();
    for (const t of tareas) if (t.vivo) { t.vivo = false; t.f(); }
    assert.deepEqual(llamadas, ['pdf'], 'cancelar evita la llamada pendiente');
  });
});
