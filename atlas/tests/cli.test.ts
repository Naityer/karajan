import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { barras, ejecutar, sparkline } from '../src/cli';

const servidor = (rutas: Record<string, unknown>) => {
  const pedidas: { url: string; metodo: string; cuerpo: unknown }[] = [];
  return {
    pedidas,
    fetch: async (url: string, init?: { method?: string; body?: string }) => {
      const ruta = url.replace('http://k', '');
      pedidas.push({ url: ruta, metodo: init?.method ?? 'GET', cuerpo: init?.body ? JSON.parse(init.body) : null });
      const clave = Object.keys(rutas).find((r) => ruta.startsWith(r));
      return { ok: !!clave, status: clave ? 200 : 404, json: async () => (clave ? rutas[clave] : { detail: 'no' }) };
    },
  };
};
const correr = async (args: string[], rutas: Record<string, unknown>) => {
  const s = servidor(rutas);
  let texto = '';
  const codigo = await ejecutar(args, { fetch: s.fetch, escribir: (x) => { texto += `${x}\n`; }, api: 'http://k' });
  return { codigo, texto, pedidas: s.pedidas };
};

describe('kj (terminal)', () => {
  it('barras y sparkline de texto', () => {
    assert.equal(sparkline([0, 0.5, 1]), '▁▅█');
    assert.equal(sparkline([null, 2, 2]), ' ▄▄');
    const b = barras([{ etiqueta: 'codex', valor: 1 }, { etiqueta: 'claude', valor: 0.5, nota: 'x' }], { ancho: 4 });
    assert.equal(b, 'codex  ████ 1\nclaude ██·· 0.5  x');
    assert.equal(barras([]), '(sin datos)');
  });

  it('lab run manda el componente y pinta hallazgos con su borrador', async () => {
    const r = await correr(['lab', 'run', 'delegador', '--sin-borradores'], { '/laboratorio/ejecutar': { informes: [{ componente: 'delegador', escenarios: [{ escenario: 'concordancia', tipo: 'replay', muestra: 4, suficiente: false, metricas: { concordancia: 0.5 }, hallazgos: [{ severidad: 'media', titulo: 'Perfil raro' }], error: null, propuestas: [{ accion: 'creada', tarea: 'ab12' }] }] }] } });
    assert.equal(r.codigo, 0);
    assert.deepEqual(r.pedidas[0], { url: '/laboratorio/ejecutar', metodo: 'POST', cuerpo: { componente: 'delegador', escenario: null, proponer: false } });
    assert.match(r.texto, /concordancia \[replay\] n=4 \(insuficiente\)/);
    assert.match(r.texto, /• \[media\] Perfil raro {2}→ borrador ab12 \(creada\)/);
  });

  it('modo, --json y errores de uso', async () => {
    assert.match((await correr(['modo'], { '/laboratorio/modo': { modo: 'produccion', fichero: 'x' } })).texto, /PRODUCCION/);
    assert.deepEqual(JSON.parse((await correr(['modo', '--json'], { '/laboratorio/modo': { modo: 'produccion', fichero: 'x' } })).texto), { modo: 'produccion', fichero: 'x' });
    assert.equal((await correr(['lab', 'run'], {})).codigo, 2);
    assert.equal((await correr(['grafica', 'nada'], {})).codigo, 2);
    await assert.rejects(correr(['propuestas'], {}), /404/);
  });

  it('gráfica de acierto por agente', async () => {
    const r = await correr(['grafica', 'acierto'], { '/analytics/eficiencia': { kpis: { tareas: 3, acierto: 0.8, retrabajo: 0.1 }, agentes: [{ agente: 'codex', tareas: 2, acierto: 0.9, retrabajo: 0, p50: 1000, coste_total: 0 }] } });
    assert.match(r.texto, /Acierto por agente \(global 80 %, re-trabajo 10 %, 3 tareas\)\ncodex █+ 90 % {2}2 tareas/);
  });
});
