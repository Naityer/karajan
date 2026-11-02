import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONFIG_BASE, normalizarConfig } from '../src/dosificador-config';
import { simular } from '../src/dosificador-sim';

/** Objetivos del dosificador con la configuración por defecto (datos sintéticos, semilla fija): ver docs/laboratorio/componentes.md. */
const SEMILLAS = [1, 2, 3];
const corridas = SEMILLAS.map((semilla) => simular(CONFIG_BASE, { semanas: 6, semilla }).metricas);
const suma = (f: (m: (typeof corridas)[number]) => number) => corridas.reduce((s, m) => s + f(m), 0);

describe('simulador del dosificador (replay sintético)', () => {
  it('es determinista: la misma semilla da las mismas métricas', () => {
    const otra = simular(CONFIG_BASE, { semanas: 6, semilla: 1 }).metricas;
    assert.deepEqual(otra, corridas[0]);
    assert.notDeepEqual(simular(CONFIG_BASE, { semanas: 2, semilla: 99 }).metricas, simular(CONFIG_BASE, { semanas: 2, semilla: 98 }).metricas);
  });
  it('ninguna semana acaba por encima del margen y nunca se topa con el límite del plan', () => {
    assert.equal(suma((m) => m.semanasPorEncima), 0, JSON.stringify(corridas.map((m) => m.porSemana.filter((w) => w.usoFinalPct > 90))));
    assert.equal(suma((m) => m.limitesAlcanzados), 0);
    assert.ok(Math.max(...corridas.map((m) => m.usoFinalMaxPct)) <= 90);
  });
  it('aprovecha la cuota: menos del 15 % sin usar al renovar (con la demanda de sobra)', () => {
    const agenteSemanas = suma((m) => m.agenteSemanas);
    assert.equal(agenteSemanas, SEMILLAS.length * 6 * 2);
    const sinUsar = suma((m) => m.sinUsarPct * m.agenteSemanas) / agenteSemanas;
    assert.ok(sinUsar < 15, `sin usar ${sinUsar.toFixed(2)} %`);
    assert.ok(sinUsar >= 10 - 1e-9, 'el margen de seguridad (10 %) sí se respeta: no se gasta');
  });
  it('el modo no oscila sin parar y la espera es finita', () => {
    for (const m of corridas) {
      assert.ok(m.oscilacionesPorSemana <= 6, `oscilaciones por semana y agente: ${m.oscilacionesPorSemana}`);
      assert.ok(m.esperaP95Horas !== null && m.esperaP95Horas < 24 * 14, `espera p95 ${m.esperaP95Horas} h`);
      assert.ok(m.tareasLanzadas > 200, 'se lanzan tareas a lo largo de las semanas');
      assert.ok(m.tareasLanzadas <= m.tareasLlegadas);
    }
  });
  it('con menos demanda que presupuesto no hay cola y se deja cuota sin usar; con margen mayor se gasta menos', () => {
    const poca = simular(CONFIG_BASE, { semanas: 3, semilla: 1, demanda: 0.4 }).metricas;
    assert.ok(poca.sinUsarPct > 40);
    assert.ok(poca.esperaP95Horas! < 24);
    const ancho = simular(normalizarConfig({ margenSeguridadPct: 25 }), { semanas: 3, semilla: 1 }).metricas;
    const normal = simular(CONFIG_BASE, { semanas: 3, semilla: 1 }).metricas;
    assert.ok(ancho.usoFinalMedioPct < normal.usoFinalMedioPct, 'más margen ⇒ se usa menos');
    assert.ok(ancho.usoFinalMaxPct <= 75 + 1e-9);
  });
  it('el estado que deja la simulación se puede guardar y reutilizar (estimador aprendido)', () => {
    const r = simular(CONFIG_BASE, { semanas: 2, semilla: 4 });
    assert.ok(Object.keys(r.estado.estimador).length > 3);
    assert.deepEqual(JSON.parse(JSON.stringify(r.estado)), r.estado);
  });
});
