import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { barras, ejecutar, graficaHtml, graficaSvg, sparkline } from '../src/cli';
import { normalizarConfig } from '../src/dosificador-config';
import { simularSolicitud } from '../src/dosificador-sim';
import { decidirSolicitud } from '../src/dosificador';
import { normalizarEstado } from '../src/dosificador-config';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RegistroLab } from '../src/laboratorio';
import { Almacen } from '../src/almacen';

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
  const ficheros = new Map<string, string>();
  const codigo = await ejecutar(args, { fetch: s.fetch, escribir: (x) => { texto += `${x}\n`; }, api: 'http://k', guardar: (ruta, contenido) => { ficheros.set(ruta, contenido); } });
  return { codigo, texto, pedidas: s.pedidas, ficheros };
};

describe('kj (terminal)', () => {
  it('planifica una misión local sin ejecutar agentes ni añadir rutas al prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kj-plan-'));
    try {
      new Almacen(join(dir, 'task_logs.db')).cerrar();
      writeFileSync(join(dir, 'active_config.json'), '{}');
      writeFileSync(join(dir, 'routing_layout.json'), '{"profiles":[{"id":"current","name":"Local","entities":[]}],"active_profile_id":"current","default_profile_id":"current"}');
      let salida = '';
      const codigo = await ejecutar(['control', 'mision', 'revisar proyecto', '--datos', dir, '--local', '--json'], {
        fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k', leer: (p) => readFileSync(p, 'utf8'), escribir: (s) => { salida = s; },
      });
      assert.equal(codigo, 0);
      assert.equal(JSON.parse(salida).datos.clasificacion.original_prompt, 'revisar proyecto');
      assert.equal(await ejecutar(['control', 'mision', 'x', '--local', '--ejecutar'], { api: 'http://k', fetch: async () => { throw new Error('red'); }, escribir: () => {} }), 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('consulta proveedores locales sin conectar con la API', async () => {
    let salida = '';
    const codigo = await ejecutar(['control', 'proveedores', '--local', '--json'], {
      fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k', escribir: (s) => { salida = s; },
    });
    assert.equal(codigo, 0);
    assert.ok(JSON.parse(salida).datos.some((x: { nombre: string }) => x.nombre === 'codex'));
  });
  it('no crea una base si falta el historial del laboratorio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kj-sin-lab-'));
    const ruta = join(dir, 'ausente.db');
    try {
      await assert.rejects(ejecutar(['lab', 'informe', 'dosificador', '--local', '--lab-db', ruta], {
        fetch: async () => { throw new Error('red'); }, api: 'http://k', escribir: () => {},
      }), /No existe la base/);
      assert.equal(existsSync(ruta), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rechaza bases de recursos incompatibles sin inventar un catálogo vacío', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kj-recursos-'));
    const ruta = join(dir, 'vacia.db');
    try {
      new DatabaseSync(ruta).close();
      let salida = '';
      const codigo = await ejecutar(['inspiration', 'resumen', '--resources-db', ruta], {
        fetch: async () => { throw new Error('red'); }, api: 'http://k', localPorDefecto: true, escribir: (s) => { salida = s; },
      });
      assert.equal(codigo, 2);
      assert.match(salida, /falta la tabla resources/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('lista tareas locales en solo lectura sin crear bases ausentes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kj-tareas-'));
    const ruta = join(dir, 'task_logs.db');
    try {
      new Almacen(ruta).cerrar();
      let salida = '';
      const entorno = { fetch: async () => { throw new Error('red'); }, api: 'http://k', localPorDefecto: true, escribir: (s: string) => { salida = s; } };
      assert.equal(await ejecutar(['estadisticas', 'tareas', '--tasks-db', ruta, '--json'], entorno), 0);
      assert.match(salida, /tareas/i);
      assert.equal(await ejecutar(['estadisticas', 'tareas', '--datos', dir, '--json'], entorno), 0);
      assert.equal(await ejecutar(['estadisticas', 'resumen', '--tasks-db', ruta, '--json'], entorno), 0);
      assert.equal(JSON.parse(salida).datos.kpis.tareas, 0);
      assert.equal(await ejecutar(['grafica', 'flujo', '--tasks-db', ruta, '--json'], entorno), 0);
      assert.equal(JSON.parse(salida).total, 0);
      assert.equal(await ejecutar(['estadisticas', 'tareas', '--tasks-db', join(dir, 'ausente.db')], entorno), 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('consulta perfiles y jerarquía locales sin conectar', async () => {
    const datos = '{"profiles":[{"id":"current","name":"Local","entities":[]}],"active_profile_id":"current","default_profile_id":"current"}';
    let salida = '';
    const entorno = { fetch: async () => { throw new Error('red'); }, api: 'http://k', localPorDefecto: true, leer: () => datos, escribir: (s: string) => { salida = s; } };
    assert.equal(await ejecutar(['control', 'perfiles', '--layout', 'perfil.json', '--json'], entorno), 0);
    assert.match(salida, /Local/);
    assert.equal(await ejecutar(['control', 'jerarquia', '--layout', 'perfil.json'], entorno), 0);
  });
  it('lee la configuración local y rechaza escritura local', async () => {
    let salida = '';
    const entorno = { fetch: async () => { throw new Error('red'); }, api: 'http://k', localPorDefecto: true, leer: () => '{}', escribir: (s: string) => { salida = s; } };
    assert.equal(await ejecutar(['dosificador', 'config', '--config', 'cfg', '--json'], entorno), 0);
    assert.equal(JSON.parse(salida).fichero, 'cfg');
    assert.equal(await ejecutar(['dosificador', 'config', '--local', '--set', '{}'], entorno), 2);
  });
  it('lee el modo local sin acudir a la API y falla si falta la ruta', async () => {
    let salida = '';
    const entorno = { fetch: async () => { throw new Error('red'); }, api: 'http://k', localPorDefecto: true, leer: () => '{"modo":"produccion"}', escribir: (s: string) => { salida = s; } };
    assert.equal(await ejecutar(['modo', '--datos', 'datos', '--json'], entorno), 0);
    assert.equal(JSON.parse(salida).modo, 'produccion');
    assert.equal(await ejecutar(['modo', '--local', '--datos', 'datos'], { ...entorno, leer: () => { throw new Error('ausente'); } }), 2);
  });
  it('ejecuta el laboratorio sintético local sin red ni borradores', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kj-lab-'));
    const ruta = join(dir, 'laboratorio.db');
    try {
      new RegistroLab(ruta).cerrar();
      let salida = '';
      const codigo = await ejecutar(['lab', 'run', 'dosificador', '--local', '--sin-borradores', '--config', 'cfg', '--lab-db', ruta, '--escenario', 'contrato', '--json'], {
        fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k', leer: () => '{}', escribir: (s) => { salida = s; },
      });
      assert.equal(codigo, 0);
      assert.equal(JSON.parse(salida).informes[0].escenarios[0].escenario, 'contrato');
      const informe = await ejecutar(['lab', 'informe', 'dosificador', '--local', '--lab-db', ruta, '--json'], {
        fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k', escribir: (s) => { salida = s; },
      });
      assert.equal(informe, 0);
      assert.equal(JSON.parse(salida)[0].escenario, 'contrato');
      const db = new DatabaseSync(ruta, { readOnly: true });
      try { assert.equal(Number(db.prepare('SELECT count(*) AS n FROM lab_ejecuciones').get()!.n), 1); } finally { db.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('decide localmente en simulacro con el mismo contrato que HTTP', async () => {
    const entrada = { ahora: 1_700_000_000_000, tareas: [], equipos: [], agentes: {}, uso: {} };
    const ficheros: Record<string, string> = { entrada: JSON.stringify(entrada), config: '{}', estado: '{}' };
    let salida = '';
    const codigo = await ejecutar(['dosificador', 'decidir', '--local', '--entrada', 'entrada', '--config', 'config', '--estado', 'estado', '--json'], {
      fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k', leer: (p) => ficheros[p]!, escribir: (s) => { salida = s; },
    });
    const esperado = decidirSolicitud(entrada, normalizarConfig({}), normalizarEstado({}));
    assert.ok(esperado.ok);
    if (!esperado.ok) throw new Error(esperado.error);
    assert.equal(codigo, 0);
    assert.deepEqual(JSON.parse(salida), { decisiones: esperado.resultado.decisiones, diferidas: esperado.resultado.diferidas, estado: esperado.resultado.resumen });
    assert.equal(ficheros.estado, '{}');
  });
  it('rechaza modo local no implementado y la combinación de transportes', async () => {
    const entorno = { fetch: async () => { throw new Error('red'); }, api: 'http://k', escribir: (_s: string) => {} };
    assert.equal(await ejecutar(['lab', 'run', 'dosificador', '--local'], entorno), 2);
    assert.equal(await ejecutar(['lab', 'ls', '--local', '--http'], entorno), 2);
  });
  it('lee componentes locales y su historial sin conectarse ni escribir en la base', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kj-local-'));
    const ruta = join(dir, 'laboratorio.db');
    try {
      writeFileSync(join(dir, 'modo.json'), '{"modo":"produccion"}');
      const db = new DatabaseSync(ruta);
      db.exec("CREATE TABLE lab_ejecuciones (id INTEGER, componente TEXT, escenario TEXT, inicio TEXT, muestra INTEGER, suficiente INTEGER, hallazgos_json TEXT, error TEXT, metricas_json TEXT); INSERT INTO lab_ejecuciones VALUES (1, 'dosificador', 'contrato', '2026-01-01', 1, 1, '[]', NULL, '{}')");
      db.close();
      let salida = '';
      const codigo = await ejecutar(['componentes', '--local', '--datos', dir, '--lab-db', ruta, '--json'], {
        fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k', escribir: (s) => { salida = s; },
        leer: (p) => readFileSync(p, 'utf8'),
      });
      assert.equal(codigo, 0);
      const componente = JSON.parse(salida).componentes.find((c: { id: string }) => c.id === 'dosificador');
      assert.equal(componente.ultimas[0].escenario, 'contrato');
      const local = await ejecutar(['lab', 'ls', '--local', '--lab-db', ruta, '--json'], {
        fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k', escribir: (s) => { salida = s; },
      });
      assert.equal(local, 0);
      const listado = JSON.parse(salida);
      assert.deepEqual(listado.find((c: { id: string }) => c.id === 'dosificador').ultimas, componente.ultimas);
      const remoto = await correr(['lab', 'ls', '--http', '--json'], { '/laboratorio/componentes': { componentes: listado } });
      assert.deepEqual(JSON.parse(remoto.texto), listado);
      const inexistente = join(dir, 'ausente.db');
      assert.equal(await ejecutar(['lab', 'ls', '--local', '--lab-db', inexistente], {
        fetch: async () => { throw new Error('red'); }, api: 'http://k', escribir: (s) => { salida = s; },
      }), 2);
      assert.match(salida, /la base no existe/);
      assert.equal(existsSync(inexistente), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('lista laboratorios locales sin hacer peticiones', async () => {
    let salida = '';
    const codigo = await ejecutar(['lab', 'ls', '--json'], {
      fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k', localPorDefecto: true,
      escribir: (s) => { salida = s; },
    });
    assert.equal(codigo, 0);
    assert.ok(JSON.parse(salida).some((c: { id: string }) => c.id === 'dosificador'));
  });
  it('no presenta tareas o borradores vacíos cuando Atlas falla en control estado', async () => {
    await assert.rejects(correr(['control', 'estado', '--http'], {
      '/laboratorio/modo': { modo: 'produccion' },
      '/providers': [],
      '/dosificador/estado': { modo: 'normal', agentes: {}, circuitos: {} },
      '/tasks': [],
    }), /No se puede consultar \/laboratorio\/propuestas: 404/);
  });
  it('no muestra grupos vacíos si falla su consulta en inspiration resumen', async () => {
    await assert.rejects(correr(['inspiration', 'resumen', '--http'], { '/resources/index': {} }), /404/);
  });
  it('simula localmente con configuración explícita sin hacer peticiones', async () => {
    let salida = '';
    const codigo = await ejecutar(['dosificador', 'simular', '--local', '--config', 'config.json', '--semanas', '1', '--json'], {
      fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k',
      escribir: (s) => { salida = s; }, leer: () => '{}',
    });
    assert.equal(codigo, 0);
    assert.deepEqual(JSON.parse(salida), simularSolicitud(normalizarConfig({}), { semanas: 1 }));
  });

  it('exige una configuración legible para simular localmente', async () => {
    let salida = '';
    const codigo = await ejecutar(['dosificador', 'simular', '--local', '--config', 'ausente'], {
      fetch: async () => { throw new Error('no debe acceder a la red'); }, api: 'http://k',
      escribir: (s) => { salida = s; }, leer: () => { throw new Error('ausente'); },
    });
    assert.equal(codigo, 2);
    assert.match(salida, /no es un JSON legible/);
  });
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

  it('exporta la gráfica a SVG y HTML autocontenidos por el entorno, sin escribir ficheros reales', async () => {
    const rutas = { '/analytics/eficiencia': { kpis: { tareas: 3, acierto: 0.8, retrabajo: 0.1 }, agentes: [{ agente: 'codex<x>', tareas: 2, acierto: 0.9, retrabajo: 0, p50: 1000, coste_total: 0 }, { agente: 'claude', tareas: 1, acierto: 0.5, retrabajo: 0, p50: null, coste_total: 0 }] } };
    const r = await correr(['grafica', 'acierto', '--svg', 'a.svg', '--html', 'a.html'], rutas);
    assert.equal(r.codigo, 0);
    assert.match(r.texto, /Gráfica guardada en a\.svg y a\.html/);
    const svg = r.ficheros.get('a.svg')!, html = r.ficheros.get('a.html')!;
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /prefers-color-scheme:dark/);
    assert.match(svg, /codex&lt;x&gt;/);
    assert.doesNotMatch(svg, /<x>/);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<svg /);
    assert.match(html, /<table>.*<th scope="row">claude<\/th>/s);
    assert.match(html, /<title>Acierto por agente/);
    assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);
  });

  it('--svg sin fichero, sin entorno de escritura o en sugerencias da error de uso', async () => {
    const rutas = { '/analytics/eficiencia': { kpis: { tareas: 0, acierto: 0, retrabajo: 0 }, agentes: [] }, '/analytics/sugerencias': { sugerencias: [] } };
    assert.equal((await correr(['grafica', 'acierto', '--svg'], rutas)).codigo, 2);
    assert.equal((await correr(['grafica', 'sugerencias', '--svg', 'x.svg'], rutas)).codigo, 2);
    let texto = '';
    const sinGuardar = await ejecutar(['grafica', 'acierto', '--svg', 'x.svg'], { fetch: servidor(rutas).fetch, escribir: (x) => { texto += x; }, api: 'http://k' });
    assert.equal(sinGuardar, 2);
    assert.match(texto, /uso:/);
  });

  it('graficaSvg y graficaHtml aguantan filas vacías y valores nulos', () => {
    assert.match(graficaSvg('t', []), /\(sin datos\)/);
    assert.match(graficaHtml('t', [{ etiqueta: 'a', valor: null }]), /<td>—<\/td>/);
  });
  describe('kj dosificador', () => {
    const agente = { datos: 'ok', usadoPct: 41, usadoSesionPct: 12, reinicio: Date.UTC(2026, 10, 8, 12), techoPct: 78, presupuestoPct: 30.2, comprometidoPct: 2, lineaPct: 38.5, errorPct: 2.5, modo: 'normal', burn: 0.5, agotamiento: null, circuitoHasta: null };
    const estado = { ahora: '2026-11-04T12:00:00.000Z', modo: 'frenado', burn: 0.52, agotamiento: null, circuitos: { claude: false, codex: true }, simulacion: false, agentes: { claude: agente, codex: { ...agente, modo: 'bloqueado', circuitoHasta: Date.UTC(2026, 10, 4, 15) } },
      ultima_decision: { en: '2026-11-04T11:59:00.000Z', decisiones: 2, diferidas: 1 }, en_vuelo: [{ tarea: 't1', agente: 'claude', equipo: 'pc', coste_p80_pct: 1.2, lanzar_en: '2026-11-04T12:30:00.000Z' }], clases_aprendidas: 7 };

    it('estado pinta cada agente con su techo, su línea y los circuitos abiertos', async () => {
      const r = await correr(['dosificador', 'estado'], { '/dosificador/estado': estado });
      assert.equal(r.codigo, 0);
      assert.match(r.texto, /Dosificador · FRENADO/);
      assert.match(r.texto, /claude {2}semanal 41 % \(techo 78 %, libre 30\.2 %, en vuelo 2 %\) · línea 38\.5 %/);
      assert.match(r.texto, /CIRCUITO ABIERTO hasta 2026-11-04 15:00/);
      assert.match(r.texto, /t1 → claude\/pc/);
      assert.equal((await correr(['dosificador'], { '/dosificador/estado': estado })).pedidas[0]!.url, '/dosificador/estado', 'sin subcomando, el estado');
      assert.deepEqual(JSON.parse((await correr(['dosificador', 'estado', '--json'], { '/dosificador/estado': estado })).texto).circuitos, { claude: false, codex: true });
    });
    it('config lee y, con --set, cambia (PUT); un JSON roto es error de uso', async () => {
      const r = await correr(['dosificador', 'config'], { '/dosificador/config': { config: { margenSeguridadPct: 10 }, fichero: '/d/dosificador.json' } });
      assert.match(r.texto, /dosificador\.json[\s\S]*"margenSeguridadPct": 10/);
      const p = await correr(['dosificador', 'config', '--set', '{"margenSeguridadPct": 12}'], { '/dosificador/config': { config: { margenSeguridadPct: 12 }, fichero: 'x' } });
      assert.deepEqual(p.pedidas[0], { url: '/dosificador/config', metodo: 'PUT', cuerpo: { margenSeguridadPct: 12 } });
      assert.equal((await correr(['dosificador', 'config', '--set', '{roto'], {})).codigo, 2);
    });
    it('decidir manda la entrada del fichero SIN guardar el estado (simulacro) y pinta decisiones y diferidas', async () => {
      const s = servidor({ '/dosificador/decidir': { decisiones: [{ tarea: 'a', agente: 'codex', equipo: 'pc', lanzarEn: null, motivo: 'codex en pc' }], diferidas: [{ tarea: 'b', hasta: Date.UTC(2026, 10, 8, 12), motivo: 'claude: agotada' }], estado: { modo: 'normal' } } });
      let texto = '';
      const codigo = await ejecutar(['dosificador', 'decidir', '--entrada', 'in.json'], { fetch: s.fetch, escribir: (x) => { texto += `${x}
`; }, api: 'http://k', leer: () => '{"ahora": 1, "tareas": []}' });
      assert.equal(codigo, 0);
      assert.deepEqual(s.pedidas[0]!.cuerpo, { ahora: 1, tareas: [], simulacro: true });
      assert.match(texto, /✔ a → codex\/pc ya/);
      assert.match(texto, /… b hasta 2026-11-08 12:00 {2}claude: agotada/);
      assert.equal((await correr(['dosificador', 'decidir'], {})).codigo, 2);
    });
    it('simular manda los parámetros y resume los objetivos', async () => {
      const r = await correr(['dosificador', 'simular', '--semanas', '3', '--demanda', '1.2'], { '/dosificador/simular': { semanas: 3, semilla: 1, agenteSemanas: 6, semanasPorEncima: 0, limitesAlcanzados: 0, sinUsarPct: 13.4, usoFinalMedioPct: 86.6, usoFinalMaxPct: 89.2, esperaP50Horas: 6, esperaP95Horas: 70.5, oscilacionesPorSemana: 1.5, tareasLanzadas: 100, tareasLlegadas: 120, pendientesAlFinal: 20 } });
      assert.deepEqual(r.pedidas[0]!.cuerpo, { semanas: 3, demanda: 1.2 });
      assert.match(r.texto, /semanas por encima del margen 0 {2}\(objetivo 0\)/);
      assert.match(r.texto, /sin usar al renovar 13\.4 % {2}\(objetivo < 15 %\)/);
      assert.equal((await correr(['dosificador', 'otra'], {})).codigo, 2);
    });
  });
});
