import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Almacen } from '../src/almacen';
import { motivoRetrabajo, nivelCorto, produccion, type SkillCatalogo, type TareaAnalitica } from '../src/produccion';

/**
 * Paridad de la analítica de producción con `app/analytics/produccion.py`: tests/generar_produccion.py guarda la entrada (las
 * tareas de tareas.db tal como las monta Python, con una revisión del baúl, y un juego sintético) y la salida de Python.
 */
const fixtures = (nombre: string) => join(import.meta.dirname, 'fixtures', nombre);
const F = JSON.parse(readFileSync(fixtures('produccion.json'), 'utf8')) as {
  ahora: string; catalogo: SkillCatalogo[]; revision_db: { task_id: string; campos: Record<string, string[]> };
  desde_db: TareaAnalitica[]; sinteticas: TareaAnalitica[];
  casos: { entrada: 'db' | 'sinteticas'; perfil: string[] | null; dias: number; no_disponibles: string[]; salida: unknown }[];
};
// JSON de Python escribe 32860.0; al leerlo es 32860, igual que en TS. Se normaliza igual los dos lados.
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe('analítica de producción: adaptador', () => {
  const dir = mkdtempSync(join(tmpdir(), 'karajan-produccion-'));
  const copia = join(dir, 'tareas.db');
  copyFileSync(fixtures('tareas.db'), copia);
  const almacen = new Almacen(copia);
  after(() => { almacen.cerrar(); rmSync(dir, { recursive: true, force: true }); });

  it('monta las tareas de la base de datos igual que Python', () => {
    almacen.guardarRevision(F.revision_db.task_id, F.revision_db.campos, '2026-10-02T00:00:00+00:00');
    const porId = (l: TareaAnalitica[]) => Object.fromEntries(l.map((t) => [t.task_id, t]));
    assert.deepStrictEqual(json(porId(almacen.tareasPlanas())), json(porId(F.desde_db)));
  });
});

describe('analítica de producción: paridad', () => {
  for (const c of F.casos) {
    it(`${c.entrada} · perfil ${c.perfil ? 'activo' : 'todos'} · ${c.dias} días`, () => {
      const entrada = c.entrada === 'db' ? F.desde_db : F.sinteticas;
      const r = produccion(entrada, { catalogo: F.catalogo, agentesPerfil: c.perfil, dias: c.dias, ahora: new Date(F.ahora), noDisponibles: c.no_disponibles });
      assert.deepStrictEqual(json(r), json(c.salida));
    });
  }
});

describe('analítica de producción: reglas', () => {
  it('detecta el re-trabajo', () => {
    assert.equal(motivoRetrabajo('Ajusta mapa-espacio.tsx y layout.ts', 'En mapa-espacio.tsx el layout.ts sigue mal'), 'vuelve sobre los mismos ficheros o componentes');
    assert.equal(motivoRetrabajo('Exporta el informe en PDF', 'Crea un endpoint de usuarios'), null);
  });
  it('normaliza el nivel', () => {
    assert.equal(nivelCorto('level_3_intermediate'), 'N3');
    assert.equal(nivelCorto('N2'), 'N2');
    assert.equal(nivelCorto('raro'), null);
  });
});
