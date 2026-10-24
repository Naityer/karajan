import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { CAPAS, COMPONENTES, ENLACES, FAMILIAS } from '../src/componentes';
import { FICHAS } from '../src/fichas-componentes';

/**
 * Responsabilidad única, comprobada: cada módulo de `src/` es de un solo componente, cada componente tiene laboratorio o dice
 * qué lo trae, y un laboratorio solo importa (en tiempo de ejecución) su propio componente y la capa base.
 */
const SRC = resolve(import.meta.dirname, '..', 'src');
const modulos = readdirSync(SRC).filter((f) => f.endsWith('.ts')).map((f) => f.slice(0, -3));
const BASE = new Set(COMPONENTES.filter((c) => c.capa === 'base').flatMap((c) => c.modulos));

describe('arquitectura por componentes', () => {
  it('cada módulo pertenece a un solo componente', () => {
    const duenos = new Map<string, string[]>();
    for (const c of COMPONENTES) for (const m of c.modulos) duenos.set(m, [...(duenos.get(m) ?? []), c.id]);
    assert.deepEqual(modulos.filter((m) => !duenos.has(m)), [], 'módulos sin componente');
    assert.deepEqual([...duenos].filter(([, cs]) => cs.length > 1), [], 'módulos en varios componentes');
    assert.deepEqual([...duenos.keys()].filter((m) => !modulos.includes(m)), [], 'componentes que citan módulos que no existen');
  });

  it('cada componente tiene una responsabilidad y su laboratorio (o qué lo trae)', () => {
    for (const c of COMPONENTES) {
      assert.ok(c.responsabilidad && !/ y (también|además)/.test(c.responsabilidad), c.id);
      assert.ok(c.laboratorio || c.pendiente, `${c.id} sin laboratorio ni pendiente`);
      if (c.laboratorio) assert.ok(c.laboratorio.escenarios.length, c.id);
    }
    assert.equal(new Set(COMPONENTES.map((c) => c.id)).size, COMPONENTES.length);
  });

  it('un laboratorio solo importa su componente y la base', () => {
    for (const f of readdirSync(join(SRC, 'lab')).filter((x) => x.endsWith('.lab.ts'))) {
      const id = f.slice(0, -'.lab.ts'.length);
      const c = COMPONENTES.find((x) => x.id === id);
      assert.ok(c, `${f} no es de ningún componente`);
      const permitidos = new Set([...c.modulos, ...BASE]);
      const codigo = readFileSync(join(SRC, 'lab', f), 'utf8');
      // Los `import type` no crean dependencia en ejecución.
      const usados = [...codigo.matchAll(/^import (?!type )[^;]*from '\.\.\/([\w-]+)';/gm)].map((m) => m[1]!);
      assert.deepEqual(usados.filter((m) => !permitidos.has(m)), [], `${f} importa fuera de su componente`);
    }
  });

  it('cada componente tiene familia, y las familias salen de las capas con su orden', () => {
    assert.deepEqual(FAMILIAS.map((f) => f.id), CAPAS.map((c) => c.id));
    assert.deepEqual(FAMILIAS.map((f) => f.orden), [0, 1, 2, 3, 4, 5]);
    assert.equal(FAMILIAS[0]!.id, 'interfaz');
    assert.equal(FAMILIAS[5]!.id, 'base');
    for (const c of COMPONENTES) assert.ok(FAMILIAS.some((f) => f.id === c.familia), `${c.id}: familia desconocida`);
  });

  it('los enlaces unen componentes que existen, sin repetirse ni apuntarse a sí mismos', () => {
    const ids = new Set(COMPONENTES.map((c) => c.id));
    for (const e of ENLACES) {
      assert.ok(ids.has(e.de), `enlace desde «${e.de}», que no es un componente`);
      assert.ok(ids.has(e.a), `enlace hacia «${e.a}», que no es un componente`);
      assert.notEqual(e.de, e.a);
    }
    assert.equal(new Set(ENLACES.map((e) => `${e.de}>${e.a}`)).size, ENLACES.length, 'enlaces repetidos');
  });

  it('cada componente tiene su ficha, y solo los que aún no tienen código son «no especificados»', () => {
    assert.deepEqual(Object.keys(FICHAS).filter((id) => !COMPONENTES.some((c) => c.id === id)), [], 'fichas de componentes que no existen');
    for (const c of COMPONENTES) {
      const f = FICHAS[c.id];
      assert.ok(f, `${c.id} sin ficha`);
      assert.ok(f.resumen && f.como_funciona.pasos.length && f.como_funciona.entradas.length && f.como_funciona.salidas.length, `${c.id}: ficha incompleta`);
      assert.equal(f.especificado, c.modulos.length > 0, `${c.id}: especificado debe coincidir con tener módulos`);
      if (c.laboratorio) assert.ok(f.como_funciona.pasos.length >= 4 && (f.reglas ?? []).length, `${c.id}: los componentes con laboratorio llevan ficha detallada`);
    }
  });
});
