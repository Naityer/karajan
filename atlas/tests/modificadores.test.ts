import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compararBrazos, laboratorioModificador, UMBRALES_AB, type ContextoModificador } from '../src/ab';
import * as eficiencia from '../src/eficiencia';
import { ENLACES } from '../src/componentes';
import { laboratorioEficiencia } from '../src/lab/eficiencia.lab';
import { laboratorioMetodo } from '../src/lab/metodo.lab';
import { laboratorioPrompts } from '../src/lab/prompts.lab';
import type { Calibracion, TareaAnonima } from '../src/laboratorio';
import * as metodo from '../src/metodo';
import * as prompts from '../src/prompts';

const MODIFICADORES = [
  { id: 'eficiencia', m: eficiencia, marca: eficiencia.MARCA_EFICIENCIA, max: eficiencia.MAX_SOBRECOSTE_EFICIENCIA, aplicaEn: { nivel: 2, intencion: 'implement_feature' }, noAplicaEn: { nivel: 5, intencion: 'implement_feature' } },
  { id: 'metodo', m: metodo, marca: metodo.MARCA_METODO, max: metodo.MAX_SOBRECOSTE_METODO, aplicaEn: { nivel: 4, intencion: 'diagnose_and_fix' }, noAplicaEn: { nivel: 1, intencion: 'diagnose_and_fix' } },
  { id: 'prompts', m: prompts, marca: prompts.MARCA_PROMPTS, max: prompts.MAX_SOBRECOSTE_PROMPTS, aplicaEn: { nivel: 3, intencion: 'classify_and_plan' }, noAplicaEn: { nivel: 1, intencion: 'classify_and_plan' } },
];

describe('transformadores de los modificadores', () => {
  for (const { id, m, marca, max, aplicaEn, noAplicaEn } of MODIFICADORES) {
    it(`${id}: conserva el texto, es idempotente y acota el sobrecoste`, () => {
      const base = 'Implementa el endpoint de exportación';
      const dev = m.aplicar(base, 'desarrollo', aplicaEn);
      assert.ok(dev.startsWith(base) && dev.includes(marca));
      assert.equal(m.aplicar(dev, 'desarrollo', aplicaEn), dev);
      assert.ok(dev.length - base.length <= max, `sobrecoste ${dev.length - base.length} > ${max}`);
    });
    it(`${id}: en producción devuelve la instrucción intacta y no aplica`, () => {
      for (const c of [aplicaEn, noAplicaEn]) {
        assert.equal(m.aplica('produccion', c), false);
        assert.equal(m.aplicar('texto', 'produccion', c), 'texto');
      }
    });
    it(`${id}: respeta su nivel e intención`, () => {
      assert.equal(m.aplica('desarrollo', aplicaEn), true);
      assert.equal(m.aplica('desarrollo', noAplicaEn), false);
      assert.equal(m.aplicar('texto', 'desarrollo', noAplicaEn), 'texto');
    });
  }

  it('siguen sin estar conectados al delegador (enlaces previstos)', () => {
    for (const id of ['eficiencia', 'metodo', 'prompts']) assert.equal(ENLACES.find((e) => e.de === id && e.a === 'delegador')?.previsto, true);
  });
});

let n = 0;
const tarea = (o: Partial<TareaAnonima>): TareaAnonima => ({
  hash: `h${n++}`, prompt: 'Implementa algo en el módulo', agenteHumano: 'codex', agenteReal: 'codex', skillsHoja: [], estado: 'completada',
  exito: true, retrabajo: false, revisada: false, clasificacionHumana: {}, ...o,
});
/** `k` aciertos de `total` tareas, con o sin la skill en la hoja. */
const grupo = (total: number, aciertos: number, skills: string[]) => Array.from({ length: total }, (_, i) => tarea({ skillsHoja: skills, exito: i < aciertos, retrabajo: i >= aciertos }));
const ctx = (tareas: TareaAnonima[], cal: Calibracion[] = []): ContextoModificador => ({
  tareas: async () => tareas, calibraciones: () => cal,
  clasificar: () => ({ nivel: 2, dominio: 'programming', intencion: 'implement_feature' }),
});
const escenario = (lab: typeof laboratorioEficiencia, id: string) => lab.escenarios.find((e) => e.id === id)!;

describe('compararBrazos', () => {
  it('concluye solo con muestra y sin solape', () => {
    assert.equal(compararBrazos(grupo(10, 10, []), grupo(10, 0, [])).conclusion, 'sin-muestra');
    assert.equal(compararBrazos(grupo(40, 38, []), grupo(40, 10, [])).conclusion, 'a-mejor');
    assert.equal(compararBrazos(grupo(40, 10, []), grupo(40, 38, [])).conclusion, 'a-peor');
    assert.equal(compararBrazos(grupo(30, 20, []), grupo(30, 18, [])).conclusion, 'sin-diferencia');
  });
});

describe('laboratorios de los modificadores', () => {
  it('el contrato de los tres da cero fallos', async () => {
    for (const lab of [laboratorioEficiencia, laboratorioMetodo, laboratorioPrompts]) {
      const r = await escenario(lab, 'contrato').ejecutar(ctx([tarea({})]));
      assert.equal(r.hallazgos.length, 0);
      assert.ok(r.muestra > 0);
    }
  });

  it('un transformador roto da un hallazgo alto en el contrato', async () => {
    const lab = laboratorioModificador({ id: 'roto', nombre: 'roto', skills: ['x'], transformador: { marca: 'm', maxSobrecoste: 5, aplica: () => true, aplicar: (i) => `${i} ${'x'.repeat(50)}` } });
    const r = await lab.escenarios[0]!.ejecutar(ctx([]));
    assert.equal(r.hallazgos[0]?.severidad, 'alta');
  });

  it('A/B con diferencia clara propone activar, como borrador y diciendo que es observacional', async () => {
    const tareas = [...grupo(40, 38, ['ponytail']), ...grupo(40, 12, [])];
    const r = await escenario(laboratorioEficiencia, 'replay-ab').ejecutar(ctx(tareas));
    assert.equal(r.suficiente, true);
    assert.equal(r.hallazgos.length, 1);
    assert.equal(r.hallazgos[0]!.clave, 'activar-eficiencia');
    assert.equal(r.hallazgos[0]!.severidad, 'media');
    assert.match(r.hallazgos[0]!.evidencia, /observacional, no aleatorizado/);
    assert.match(String((r.detalle as { diseno: string }).diseno), /no aleatorizado/);
  });

  it('A/B con el modificador peor propone retirarlo', async () => {
    const tareas = [...grupo(40, 10, ['superpowers']), ...grupo(40, 36, [])];
    const r = await escenario(laboratorioMetodo, 'replay-ab').ejecutar(ctx(tareas));
    assert.equal(r.hallazgos[0]?.clave, 'retirar-metodo');
  });

  it('A/B sin muestra mínima o con intervalos solapados no concluye', async () => {
    const corta = await escenario(laboratorioPrompts, 'replay-ab').ejecutar(ctx([...grupo(UMBRALES_AB.muestraMinima - 1, 19, ['dspy']), ...grupo(40, 5, [])]));
    assert.equal(corta.suficiente, false);
    assert.equal(corta.hallazgos.length, 0);
    assert.ok(corta.metricas['acierto_a'] !== null);
    const solapada = await escenario(laboratorioPrompts, 'replay-ab').ejecutar(ctx([...grupo(30, 20, ['promptfoo']), ...grupo(30, 18, [])]));
    assert.equal(solapada.suficiente, true);
    assert.equal(solapada.hallazgos.length, 0);
  });

  it('feedback: rechazo claro con muestra suficiente propone retirar; con poca muestra, nada', async () => {
    const cal = (si: number, no: number): Calibracion[] => [...Array(si).fill('si'), ...Array(no).fill('no')].map((respuesta, i) => ({ tarea_hash: `c${i}`, componente: 'eficiencia', propuesta: ['ponytail'], respuesta, correccion: [], creada: '2026-01-01' }));
    const rechazo = await escenario(laboratorioEficiencia, 'feedback').ejecutar(ctx([], cal(2, 40)));
    assert.equal(rechazo.hallazgos[0]?.clave, 'rechazado-eficiencia');
    const corto = await escenario(laboratorioEficiencia, 'feedback').ejecutar(ctx([], cal(1, 5)));
    assert.equal(corto.suficiente, false);
    assert.equal(corto.hallazgos.length, 0);
  });
});
