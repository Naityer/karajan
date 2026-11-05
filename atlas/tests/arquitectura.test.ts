import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { CAPAS, COMPARTIDOS, COMPONENTES, ENLACES, FAMILIAS } from '../src/componentes';
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
    assert.deepEqual(modulos.filter((m) => !duenos.has(m) && !COMPARTIDOS.includes(m)), [], 'módulos sin componente (ni compartidos)');
    assert.deepEqual(COMPARTIDOS.filter((m) => duenos.has(m) || !modulos.includes(m)), [], 'compartidos que son de un componente o no existen');
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

  describe('dependencias entre componentes', () => {
    const duenoDe = new Map(COMPONENTES.flatMap((c) => c.modulos.map((m) => [m, c.id] as const)));
    /** Imports en ejecución (sin `import type`) que cada componente hace a módulos de OTRO componente; los compartidos no cuentan. */
    const reales = (id: string): string[] => {
      const salida = new Set<string>();
      for (const m of COMPONENTES.find((c) => c.id === id)!.modulos) {
        const codigo = readFileSync(join(SRC, `${m}.ts`), 'utf8');
        for (const x of codigo.matchAll(/^(?:import|export) (?!type )[^;]*from '\.\/([\w-]+)';/gm)) {
          const d = duenoDe.get(x[1]!);
          if (d && d !== id) salida.add(d);
        }
      }
      return [...salida].sort();
    };
    const raices = COMPONENTES.filter((c) => c.requiere === 'todos').map((c) => c.id);

    it('lo que cada componente declara que requiere es lo que su código importa (ni más ni menos)', () => {
      for (const c of COMPONENTES) {
        if (c.requiere === 'todos') continue;
        assert.deepEqual([...c.requiere].sort(), reales(c.id), `${c.id}: dependencias declaradas ≠ imports reales`);
      }
    });

    it('lo requerido existe, no se repite ni apunta a uno mismo; solo api y laboratorio son raíces de composición', () => {
      const ids = new Set(COMPONENTES.map((c) => c.id));
      for (const c of COMPONENTES) if (c.requiere !== 'todos') {
        assert.equal(new Set(c.requiere).size, c.requiere.length, `${c.id}: repetidas`);
        for (const r of c.requiere) { assert.ok(ids.has(r), `${c.id} requiere «${r}», que no existe`); assert.notEqual(r, c.id); }
      }
      assert.deepEqual(raices.sort(), ['api', 'laboratorio']);
    });

    it('no hay ciclos entre componentes (las raíces quedan fuera)', () => {
      const grafo = new Map(COMPONENTES.filter((c) => c.requiere !== 'todos').map((c) => [c.id, c.requiere as string[]]));
      const estado = new Map<string, 1 | 2>();
      const visita = (id: string, ruta: string[]) => {
        if (estado.get(id) === 2) return;
        assert.notEqual(estado.get(id), 1, `ciclo: ${[...ruta, id].join(' → ')}`);
        estado.set(id, 1);
        for (const d of grafo.get(id) ?? []) if (grafo.has(d)) visita(d, [...ruta, id]);
        estado.set(id, 2);
      };
      for (const id of grafo.keys()) visita(id, []);
    });

    it('los componentes de la capa base no dependen de capas superiores', () => {
      const capa = new Map(COMPONENTES.map((c) => [c.id, c.capa]));
      for (const c of COMPONENTES.filter((x) => x.capa === 'base' && x.requiere !== 'todos')) {
        for (const r of c.requiere as string[]) assert.equal(capa.get(r), 'base', `${c.id} (base) requiere ${r} (${capa.get(r)})`);
      }
    });

    it('la configuración declarada apunta a rutas del paquete y la escritura implica lectura', () => {
      for (const c of COMPONENTES) if (c.config) {
        assert.match(c.config.lectura, /^\//, c.id);
        if (c.config.escritura) assert.match(c.config.escritura, /^\//, c.id);
      }
    });
  });
});
