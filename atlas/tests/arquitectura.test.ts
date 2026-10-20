import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { COMPONENTES } from '../src/componentes';

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
});
