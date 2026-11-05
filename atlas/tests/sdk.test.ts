import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

import { ejecutar } from '../src/cli';
import { arbol, barras, dispersion, flujo, heatmap, medidor, rango, sparkline, tabla } from '../src/sdk/ascii';
import { RegistroComandos } from '../src/sdk/comandos';
import { renderAscii, renderJson, type Panel } from '../src/sdk/panel';
import { crearRegistro } from '../src/sdk/registro';

const servidor = (rutas: Record<string, unknown>) => async (url: string) => {
  const ruta = url.replace('http://k', '');
  const clave = Object.keys(rutas).sort((a, b) => b.length - a.length).find((r) => ruta.startsWith(r));
  return { ok: !!clave, status: clave ? 200 : 404, json: async () => (clave ? rutas[clave] : { detail: 'no' }) };
};
const correr = async (args: string[], rutas: Record<string, unknown>) => {
  let texto = '';
  const codigo = await ejecutar(args, { fetch: servidor(rutas), escribir: (x) => { texto += `${x}\n`; }, api: 'http://k' });
  return { codigo, texto };
};

describe('sdk · piezas ASCII', () => {
  it('medidor, tabla y arbol son deterministas', () => {
    assert.equal(medidor(0.5, 1, { ancho: 10 }), '[█████·····] 50 %');
    assert.equal(medidor(null, 1, { ancho: 4 }), '[····] —');
    assert.equal(tabla(['a', 'n'], [['x', 1], ['yy', 22]]), 'a  │  n\n───┼───\nx  │  1\nyy │ 22'.replace('───┼───', '───┼───'));
    assert.equal(arbol({ nombre: 'raíz', hijos: [{ nombre: 'a', hijos: [{ nombre: 'a1' }] }, { nombre: 'b', nota: '(x)' }] }), 'raíz\n├─ a\n│  └─ a1\n└─ b  (x)');
  });

  it('heatmap usa la rampa y marca lo que es 0 distinto de lo ausente', () => {
    const h = heatmap(['s1', 's2'], ['ca', 'cb'], [[4, 0], [1, null]]);
    const [cab, f1, f2] = h.split('\n');
    assert.equal(cab, '   A B');
    assert.equal(f1, 's1 ██'); // el 0 es hueco; la ausencia de dato es «··»
    assert.equal(f2, 's2 ░░··');
  });

  it('rango pinta p50, p90 y p99 en una regla común', () => {
    const r = rango([{ etiqueta: 'codex', p50: 0, p90: 10, p99: 20 }], { ancho: 5 });
    assert.ok(r.startsWith('codex ●─◆─▲') || r.startsWith('codex ●'), r);
    assert.match(r, /p50 0 · p90 10/);
  });

  it('dispersion numera los puntos y da leyenda; flujo lista enlaces ordenados', () => {
    const d = dispersion([{ etiqueta: 'a', x: 0, y: 0 }, { etiqueta: 'b', x: 10, y: 5 }], { ejeX: 'x', ejeY: 'y', ancho: 10, alto: 4 });
    assert.match(d, /1 a {2}\(0, 0\)/);
    assert.match(d, /2 b {2}\(10, 5\)/);
    const f = flujo([{ nombre: 'entrada', nodos: [{ id: 'e1', nombre: 'claude', valor: 2 }] }, { nombre: 'estado', nodos: [{ id: 's1', nombre: 'ok', valor: 2 }] }], [{ origen: 'e1', destino: 's1', valor: 2 }]);
    assert.match(f, /entrada:claude ─\(2\)→ estado:ok/);
    assert.equal(barras([]), '(sin datos)');
    assert.equal(sparkline([0, 0.5, 1]), '▁▅█');
  });
});

describe('sdk · panel y registro', () => {
  const panel: Panel = { origen: 'x', titulo: 'T', subtitulo: 'S', datos: { a: 1 }, bloques: [{ tipo: 'texto', titulo: 'B', lineas: ['hola'] }] };

  it('el mismo panel se pinta en ASCII o se entrega en JSON', () => {
    assert.match(renderAscii(panel), /^T {2}·{1} {2}S\n═+\nB\n─\nhola$/);
    const j = JSON.parse(renderJson(panel));
    assert.deepEqual([j.origen, j.titulo, j.datos, j.bloques.length], ['x', 'T', { a: 1 }, 1]);
  });

  it('el registro resuelve por prefijo, el más específico gana, y rechaza duplicados', () => {
    const r = new RegistroComandos();
    const vacio = async () => panel;
    r.registrar({ ruta: ['a', 'b'], resumen: '', ejecutar: vacio }, { ruta: ['*', 'b'], resumen: '', ejecutar: vacio });
    assert.deepEqual(r.resolver(['a', 'b', '--json'])?.comando.ruta, ['a', 'b']);
    assert.deepEqual(r.resolver(['z', 'b'])?.ruta, ['z', 'b']);
    assert.equal(r.resolver(['z']), null);
    assert.throws(() => r.registrar({ ruta: ['a', 'b'], resumen: '', ejecutar: vacio }), /duplicado/);
  });

  it('el registro de Karajan trae los módulos y los comandos genéricos de componente', () => {
    const rutas = crearRegistro().todos().map((c) => c.ruta.join(' '));
    for (const esperado of ['estadisticas resumen', 'estadisticas agentes', 'estadisticas skills', 'estadisticas tareas', '* describe', '* config', '* salud', '* metricas']) assert.ok(rutas.includes(esperado), esperado);
  });
});

const PRODUCCION = {
  dias: 30, perfil: 'todos', kpis: { tareas: 10, delegadas: 8, acierto: 0.75, retrabajo: 0.1, revisadas: 2 },
  flujo: { total: 10, nodos: [{ id: 'e:claude', capa: 'entrada', nombre: 'claude', valor: 10 }, { id: 'a:codex', capa: 'agente', nombre: 'codex', valor: 10 }], enlaces: [{ origen: 'e:claude', destino: 'a:codex', valor: 10 }] },
  eficiencia: { agentes: [{ agente: 'codex', tareas: 6, runs: 7, coste_medio: 0.5, coste_total: 3, latencia_media: 2000, p50: 1500, p90: 3000, acierto: 0.8, retrabajo: 0.1 }, { agente: 'qwen', tareas: 4, runs: 4, coste_medio: 0, coste_total: 0, latencia_media: 9000, p50: 8000, p90: 12000, acierto: 0.5, retrabajo: 0.3 }] },
  matriz: { categorias: ['backend', 'tests'], usadas: 2, total: 3, serie: [{ semana: '2026-W40', skill: 'tdd', usos: 2 }, { semana: '2026-W41', skill: 'tdd', usos: 5 }],
    filas: [{ skill: 'tdd', categoria: 'tests', instalada: true, usos: 7, recomendada: 9, celdas: { tests: { usos: 7, acierto: 0.9 } }, agentes: { codex: 7 } }, { skill: 'ponytail', categoria: 'backend', instalada: true, usos: 3, recomendada: 3, celdas: { backend: { usos: 3, acierto: null } }, agentes: { qwen: 3 } }] },
  sugerencias: [{ severidad: 'media', texto: 'Qwen falla más de lo esperado' }],
};

describe('kj estadisticas (módulo)', () => {
  it('resumen: indicadores, flujo, dispersión y qué mejorar, en ASCII', async () => {
    const r = await correr(['estadisticas', 'resumen'], { '/analytics/produccion': PRODUCCION });
    assert.equal(r.codigo, 0);
    assert.match(r.texto, /Estadísticas · resumen {2}· {2}últimos 30 días · perfil todos/);
    assert.match(r.texto, /75 %/);
    assert.match(r.texto, /ENLACES/);
    assert.match(r.texto, /1 codex \(6 tareas\)/);
    assert.match(r.texto, /\[media\] Qwen falla/);
  });

  it('agentes y skills dibujan barras, rangos, serie y mapas de calor', async () => {
    const a = await correr(['estadisticas', 'agentes', '--dias', '7'], { '/analytics/produccion?dias=7&perfil=todos': PRODUCCION });
    assert.match(a.texto, /● p50 {2}◆ p90 {2}▲ p99/);
    assert.match(a.texto, /codex +█+·* 6/);
    const s = await correr(['estadisticas', 'skills'], { '/analytics/produccion': PRODUCCION });
    assert.match(s.texto, /Actividad semanal/);
    assert.match(s.texto, /Agente × skill/);
    assert.match(s.texto, /Columnas: A=codex {2}B=qwen/);
  });

  it('--json entrega el panel (datos y bloques) para la interfaz', async () => {
    const r = await correr(['estadisticas', 'agentes', '--json'], { '/analytics/produccion': PRODUCCION });
    const j = JSON.parse(r.texto);
    assert.equal(j.origen, 'estadisticas');
    assert.equal(j.datos.agentes.length, 2);
    assert.ok(j.bloques.some((b: { tipo: string }) => b.tipo === 'rango'));
  });

  it('tareas y tarea muestran la lista y el detalle con criterios', async () => {
    const t = { task_id: 'abc123def456xyz', status: 'completed', prompt: 'arregla el bug', created_at: '2026-11-05T10:00:00', classification: { complexity_level: 3, recommended_model: 'codex', criteria: { ambiguity: 2, risk: 4 } } };
    const l = await correr(['estadisticas', 'tareas'], { '/tasks?limit=20': [t] });
    assert.match(l.texto, /abc123def456 +│ completed +│ N3 +│ codex/);
    const d = await correr(['estadisticas', 'tarea', 'abc123def456xyz'], { '/tasks/abc123def456xyz/decisions': [{ phase: 'classify', decision: 'N3' }], '/tasks/abc123def456xyz': t });
    assert.match(d.texto, /risk +█+/);
    assert.match(d.texto, /classify: N3/);
    await assert.rejects(correr(['estadisticas', 'tarea'], {}), /uso: kj estadisticas tarea/);
  });
});

describe('kj <componente> (comandos genéricos)', () => {
  const VISTA = {
    id: 'curador', familia: 'modificadores', responsabilidad: 'Proponer qué skills sobran', modulos: ['curador'], estado: 'hallazgos', muestra_corta: false, pendiente: null,
    ficha: { especificado: true, resumen: 'Reglas inequívocas', como_funciona: { entradas: ['skills'], pasos: ['aplica reglas'], salidas: ['propuestas'] }, reglas: ['no propone retirar lo usado'] },
    configuracion: { dias_sin_uso: 30, protegidas: ['a', 'b'] }, escenarios: [{ id: 'invariantes', tipo: 'contrato', descripcion: 'reglas' }],
    ultimas: [{ escenario: 'invariantes', inicio: '2026-11-05', muestra: 5, suficiente: true, hallazgos: 1, error: null, metricas: { ok: 1 } }], historial: { ok: [{ valor: 1 }, { valor: 2 }] },
    hallazgos: [{ severidad: 'media', titulo: 'sobra x', escenario: 'invariantes', borrador: { tarea: 'T-1', estado: 'borrador' } }],
    operacion: { tareas: 3, runs: null, latencia_p50_ms: null, coste_total_usd: null, ultima_actividad: null, extra: { propuestas: 2 } }, avisos: [],
  };
  const rutas = { '/laboratorio/arquitectura/curador': VISTA };

  it('describe, config, salud y metricas salen de la misma vista', async () => {
    const d = await correr(['curador', 'describe'], rutas);
    assert.match(d.texto, /curador · describe {2}· {2}modificadores · hallazgos/);
    assert.match(d.texto, /• aplica reglas/);
    assert.match(await correr(['curador', 'config'], rutas).then((x) => x.texto), /dias_sin_uso +│ 30/);
    assert.match(await correr(['curador', 'salud'], rutas).then((x) => x.texto), /\[media\] sobra x \(invariantes\) → borrador T-1 · borrador/);
    const m = await correr(['curador', 'metricas'], rutas);
    assert.match(m.texto, /propuestas +│ 2/);
    assert.match(m.texto, /Historial · ok/);
  });

  it('un componente que no existe da el error del servidor y los comandos propios siguen mandando', async () => {
    await assert.rejects(correr(['nada', 'describe'], {}), /404/);
    // `kj dosificador config` sigue siendo el comando propio (lee y escribe): no lo intercepta el genérico `<componente> config`.
    await assert.doesNotReject(correr(['dosificador', 'config'], { '/dosificador/config': {} }));
  });
});

describe('sdk · reglas de arquitectura', () => {
  it('el SDK no depende de ningún componente: solo de sí mismo', () => {
    const raiz = resolve(import.meta.dirname, '..', 'src', 'sdk');
    const ficheros = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? ficheros(join(d, x.name)) : x.name.endsWith('.ts') ? [join(d, x.name)] : []));
    for (const f of ficheros(raiz)) {
      const salidas = [...readFileSync(f, 'utf8').matchAll(/^import (?!type )[^;]*from '(\.[^']*)';/gm)].map((m) => m[1]!);
      for (const s of salidas) assert.ok(/^\.\.?\/(?:\.\.\/)?(?:comandos|panel|ascii|componentes-cli|modulos\/[\w-]+)$/.test(s) || s.startsWith('./') || s.startsWith('../comandos') || s.startsWith('../panel'), `${f} importa ${s}`);
    }
  });
});
