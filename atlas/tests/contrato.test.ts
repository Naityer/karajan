import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { construirArquitectura } from '../src/arquitectura';
import { ejecutar } from '../src/cli';
import { COMPONENTES } from '../src/componentes';

type Llamada = { ruta: string; metodo: string; cuerpo: unknown; cabeceras: Record<string, string> };
const correr = async (args: string[], rutas: Record<string, unknown>) => {
  let texto = '';
  const llamadas: Llamada[] = [];
  const codigo = await ejecutar(args, {
    api: 'http://k', escribir: (x) => { texto += `${x}\n`; },
    fetch: async (url, init) => {
      const ruta = url.replace('http://k', '');
      llamadas.push({ ruta, metodo: init?.method ?? 'GET', cuerpo: init?.body ? JSON.parse(init.body) : null, cabeceras: init?.headers ?? {} });
      const clave = Object.keys(rutas).sort((a, b) => b.length - a.length).find((r) => ruta.startsWith(r));
      return { ok: !!clave, status: clave ? 200 : 404, json: async () => (clave ? rutas[clave] : { detail: 'no' }) };
    },
  });
  return { codigo, texto, llamadas };
};

const vista = (id: string, extra: Record<string, unknown> = {}) => ({
  id, familia: 'decision', responsabilidad: `resp ${id}`, modulos: [id], requiere: ['almacen', 'limites'], config: { lectura: `/${id}/config`, escritura: `/${id}/config` }, estado: 'ok', muestra_corta: false, pendiente: null,
  ficha: { especificado: true, resumen: 'r', como_funciona: { entradas: [], pasos: [], salidas: [] }, reglas: [] }, configuracion: { margen: 10, activos: ['a', 'b'] },
  escenarios: [], ultimas: [], historial: {}, hallazgos: [], operacion: { tareas: null, runs: null, latencia_p50_ms: null, coste_total_usd: null, ultima_actividad: null, extra: null }, avisos: [], ...extra,
});

describe('contrato de componente: requiere y config', () => {
  it('todos los componentes declaran requiere y la vista de arquitectura lo entrega con su configuración', () => {
    for (const c of COMPONENTES) assert.ok(c.requiere === 'todos' || Array.isArray(c.requiere), c.id);
    const dos = COMPONENTES.find((c) => c.id === 'dosificador')!;
    assert.deepEqual(dos.config, { lectura: '/dosificador/config', escritura: '/dosificador/config' });
    assert.deepEqual(COMPONENTES.find((c) => c.id === 'delegador')!.config, { lectura: '/routing-layout' });
    assert.ok(typeof construirArquitectura === 'function');
  });

  it('describe dice de qué depende; las raíces y los independientes se distinguen', async () => {
    assert.match((await correr(['delegador', 'describe'], { '/laboratorio/arquitectura/delegador': vista('delegador') })).texto, /Depende de: almacen, limites/);
    assert.match((await correr(['api', 'describe'], { '/laboratorio/arquitectura/api': vista('api', { requiere: 'todos' }) })).texto, /Depende de: todos \(raíz de composición\)/);
    assert.match((await correr(['rotador', 'describe'], { '/laboratorio/arquitectura/rotador': vista('rotador', { requiere: [] }) })).texto, /Depende de: nadie \(independiente\)/);
  });

  it('config muestra si se puede cambiar y cómo', async () => {
    const con = await correr(['curador', 'config'], { '/laboratorio/arquitectura/curador': vista('curador') });
    assert.match(con.texto, /margen +│ 10/);
    assert.match(con.texto, /kj curador config --set/);
    const sin = await correr(['curador', 'config'], { '/laboratorio/arquitectura/curador': vista('curador', { config: { lectura: '/x' } }) });
    assert.match(sin.texto, /Solo lectura: este componente no declara/);
  });

  it('config --set escribe por PUT en la ruta declarada, con la tarea aceptada si se da, y muestra lo cambiado', async () => {
    const r = await correr(['curador', 'config', '--set', '{"margen": 20}', '--tarea', 'T-9'], { '/laboratorio/arquitectura/curador': vista('curador'), '/curador/config': { margen: 20 } });
    const put = r.llamadas.find((l) => l.metodo === 'PUT')!;
    assert.deepEqual([put.ruta, put.cuerpo, put.cabeceras['x-karajan-tarea']], ['/curador/config', { margen: 20 }, 'T-9']);
    assert.match(r.texto, /curador · config actualizada/);
    assert.match(r.texto, /margen = 20/);
  });

  it('config --set rechaza lo que no es un objeto JSON y lo que no tiene ruta de escritura, sin escribir nada', async () => {
    const rutas = { '/laboratorio/arquitectura/curador': vista('curador') };
    for (const malo of ['{roto', '[1]', '"x"', '3']) {
      await assert.rejects(correr(['curador', 'config', '--set', malo], rutas), /--set espera/);
    }
    const sola = { '/laboratorio/arquitectura/curador': vista('curador', { config: { lectura: '/x' } }) };
    await assert.rejects(correr(['curador', 'config', '--set', '{"a":1}'], sola), /configuración de solo lectura/);
    const r = await correr(['curador', 'config'], rutas);
    assert.equal(r.llamadas.filter((l) => l.metodo === 'PUT').length, 0);
  });

  it('componentes dependencias: árbol, quién usa a quién, independientes y raíces', async () => {
    const vs = [vista('delegador'), vista('almacen', { familia: 'base', requiere: [] }), vista('limites', { familia: 'ejecucion', requiere: [] }), vista('api', { familia: 'interfaz', requiere: 'todos' })];
    const { texto } = await correr(['componentes', 'dependencias'], { '/laboratorio/arquitectura': { componentes: vs } });
    assert.match(texto, /Componentes · dependencias {2}· {2}4 componentes/);
    assert.match(texto, /Componentes con dependencias\n└─ delegador {2}\(decision\)\n {3}├─ almacen\n {3}└─ limites/);
    assert.match(texto, /almacen +│ delegador/);
    assert.match(texto, /Independientes\n─+\nalmacen, limites/);
    assert.match(texto, /Raíces de composición[^\n]*\n─+\napi/);
  });
});
