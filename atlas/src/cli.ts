import { pathToFileURL } from 'node:url';

/**
 * `kj`: Karajan desde la terminal (sustituye a la interfaz). Habla con el paquete dentro de Atlas dev
 * (`{ATLAS_DEV_API}/paquetes/karajan/api`, o `KARAJAN_API`) con el token de `at` (`ATLAS_DEV_TOKEN`). Sin dependencias: las
 * gráficas son barras y sparklines de texto; `--json` da los datos tal cual para otras herramientas.
 *
 *   kj componentes                          la pila por capas, con el estado del último laboratorio
 *   kj lab ls                               laboratorios y escenarios
 *   kj lab run <componente|todos> [--escenario x] [--sin-borradores]
 *   kj lab informe <componente>             la última ejecución de cada escenario
 *   kj lab historial <componente> <métrica> evolución de una métrica (sparkline)
 *   kj grafica acierto|eficiencia|flujo|matriz-skills|sugerencias [--dias N] [--perfil todos]
 *   kj comparar [<skill>|karajan] [--grupo g]  cada skill (o Karajan) frente a las mejores de su grupo, con estrellas propias
 *   kj propuestas                           borradores abiertos por Karajan y su estado
 *   kj modo                                 producción o desarrollo
 */
type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
interface Entorno { fetch: Fetch; escribir: (s: string) => void; api: string }

const BLOQUES = '▁▂▃▄▅▆▇█';
export function sparkline(valores: (number | null)[]): string {
  const v = valores.filter((x): x is number => x !== null && Number.isFinite(x));
  if (!v.length) return '';
  const min = Math.min(...v), max = Math.max(...v);
  return valores.map((x) => (x === null || !Number.isFinite(x) ? ' ' : BLOQUES[max === min ? 3 : Math.round(((x - min) / (max - min)) * 7)]!)).join('');
}

export function barras(filas: { etiqueta: string; valor: number | null; nota?: string }[], { ancho = 30, formato = (x: number) => String(x) } = {}): string {
  if (!filas.length) return '(sin datos)';
  const max = Math.max(0, ...filas.map((f) => f.valor ?? 0)) || 1;
  const largo = Math.min(28, Math.max(...filas.map((f) => f.etiqueta.length)));
  return filas.map((f) => {
    const n = f.valor === null ? 0 : Math.round((f.valor / max) * ancho);
    return `${f.etiqueta.slice(0, largo).padEnd(largo)} ${'█'.repeat(n)}${'·'.repeat(ancho - n)} ${f.valor === null ? '—' : formato(f.valor)}${f.nota ? `  ${f.nota}` : ''}`;
  }).join('\n');
}

const pct = (x: number) => `${Math.round(x * 100)} %`;
const opcion = (args: string[], nombre: string) => { const i = args.indexOf(`--${nombre}`); return i >= 0 ? args[i + 1] ?? '' : null; };
const bandera = (args: string[], nombre: string) => args.includes(`--${nombre}`);

async function pedir(e: Entorno, ruta: string, metodo = 'GET', cuerpo?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env['ATLAS_DEV_TOKEN']) headers['x-atlas-dev-token'] = process.env['ATLAS_DEV_TOKEN'];
  const r = await e.fetch(`${e.api}${ruta}`, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const datos = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${r.status}: ${(datos as { detail?: string } | null)?.detail ?? 'error'}`);
  return datos;
}

interface ComponenteVista { id: string; capa: string; responsabilidad: string; pendiente: string | null; escenarios: { id: string; tipo: string; descripcion: string }[]; ultimas: { escenario: string; inicio: string; muestra: number; suficiente: boolean; hallazgos: number; error: string | null; metricas: Record<string, number | null> }[] }
interface Ejecucion { escenario: string; tipo: string; inicio: string; muestra: number; suficiente: boolean; metricas: Record<string, number | null>; hallazgos: { severidad: string; titulo: string }[]; error: string | null; propuestas?: { accion: string; tarea: string | null }[] }

function estadoDe(c: ComponenteVista): string {
  if (!c.escenarios.length) return 'sin laboratorio';
  if (!c.ultimas.length) return 'sin ejecutar';
  if (c.ultimas.some((u) => u.error)) return 'error';
  const h = c.ultimas.reduce((s, u) => s + u.hallazgos, 0);
  return `${h ? `${h} hallazgo${h === 1 ? '' : 's'}` : 'ok'}${c.ultimas.some((u) => !u.suficiente) ? ' (muestra corta)' : ''}`;
}

interface Comparada { sujeto: string; estado: string; motivo: string; grupoNombre: string | null; estrellas: number | null; posicion: number | null; percentil: number | null; conDato: number; mejores: { nombre: string; estrellas: number }[]; faltan: { funcionalidad: string; pares: string[] }[] }
interface PruebaVista { nombre: string; pares: { par: string; estrellas: number }[] }

function pintarComparada(c: Comparada): string {
  const puesto = c.percentil !== null ? ` · puesto ${c.posicion} (p${c.percentil}, ${c.estrellas}★ propias)` : ' · sin dato: no se puntúa';
  const lineas = [`${c.sujeto} · ${c.grupoNombre ?? 'sin grupo'} · ${c.estado}${puesto}`];
  if (c.motivo) lineas.push(`  ${c.motivo}`);
  if (c.mejores.length) lineas.push(`Mejores del grupo (${c.conDato} con estrellas propias)`, barras(c.mejores.map((m) => ({ etiqueta: m.nombre, valor: m.estrellas }))));
  if (c.faltan.length) lineas.push('Funcionalidades declaradas por los pares y no por ella', ...c.faltan.map((f) => `  • ${f.funcionalidad}  (${f.pares.join(', ')})`));
  return lineas.join('\n');
}

function pintarEjecucion(x: Ejecucion): string {
  const metricas = Object.entries(x.metricas).map(([k, v]) => `${k}=${v === null ? '—' : v}`).join('  ');
  const lineas = [`  ${x.escenario} [${x.tipo}] n=${x.muestra}${x.suficiente ? '' : ' (insuficiente)'}${x.error ? `  ERROR: ${x.error}` : ''}`, `    ${metricas || '(sin métricas)'}`];
  for (const [i, h] of x.hallazgos.entries()) {
    const p = x.propuestas?.[i];
    lineas.push(`    • [${h.severidad}] ${h.titulo}${p?.tarea ? `  → borrador ${p.tarea} (${p.accion})` : ''}`);
  }
  return lineas.join('\n');
}

export async function ejecutar(args: string[], e: Entorno): Promise<number> {
  const [cmd, sub, ...resto] = args;
  const json = bandera(args, 'json');
  const salida = (datos: unknown, texto: () => string) => e.escribir(json ? JSON.stringify(datos, null, 2) : texto());
  switch (cmd) {
    case 'modo': {
      const m = (await pedir(e, '/laboratorio/modo')) as { modo: string; fichero: string };
      salida(m, () => `Karajan en ${m.modo.toUpperCase()}${m.modo === 'produccion' ? ': los cambios necesitan una tarea aceptada; el resto se propone como borrador.' : '.'}\n(${m.fichero}, solo se cambia editando el fichero)`);
      return 0;
    }
    case 'componentes': {
      const d = (await pedir(e, '/laboratorio/componentes')) as { version: string; modo: string; capas: { id: string; nombre: string }[]; componentes: ComponenteVista[] };
      salida(d, () => [`Karajan ${d.version} · ${d.modo}`, ...d.capas.flatMap((capa) => {
        const cs = d.componentes.filter((c) => c.capa === capa.id);
        return [`┌ ${capa.nombre}`, ...cs.map((c) => `│ ${c.id.padEnd(13)} ${estadoDe(c).padEnd(26)} ${c.responsabilidad}`)];
      }), '└'].join('\n'));
      return 0;
    }
    case 'lab': {
      if (sub === 'ls') {
        const d = (await pedir(e, '/laboratorio/componentes')) as { componentes: ComponenteVista[] };
        salida(d.componentes, () => d.componentes.map((c) => c.escenarios.length
          ? `${c.id}\n${c.escenarios.map((s) => `  ${s.id.padEnd(22)} ${s.tipo.padEnd(9)} ${s.descripcion}`).join('\n')}`
          : `${c.id}  — ${c.pendiente ?? 'sin laboratorio'}`).join('\n'));
        return 0;
      }
      if (sub === 'run') {
        const componente = resto.find((a) => !a.startsWith('--')) ?? '';
        if (!componente) { e.escribir('uso: kj lab run <componente|todos> [--escenario x] [--sin-borradores]'); return 2; }
        const d = (await pedir(e, '/laboratorio/ejecutar', 'POST', { componente, escenario: opcion(args, 'escenario'), proponer: !bandera(args, 'sin-borradores') })) as { informes: { componente: string; escenarios: Ejecucion[] }[] };
        salida(d, () => d.informes.map((i) => `${i.componente}\n${i.escenarios.map(pintarEjecucion).join('\n')}`).join('\n\n'));
        return 0;
      }
      if (sub === 'informe') {
        const componente = resto[0] ?? '';
        const d = (await pedir(e, `/laboratorio/ejecuciones?componente=${encodeURIComponent(componente)}&limite=100`)) as Ejecucion[];
        const vistos = new Set<string>();
        const ultimas = d.filter((x) => !vistos.has(x.escenario) && vistos.add(x.escenario));
        salida(ultimas, () => (ultimas.length ? `${componente} · ${ultimas[0]!.inicio.slice(0, 16).replace('T', ' ')}\n${ultimas.map(pintarEjecucion).join('\n')}` : `Sin ejecuciones de «${componente}»: kj lab run ${componente}`));
        return 0;
      }
      if (sub === 'historial') {
        const [componente = '', metrica = ''] = resto;
        const d = ((await pedir(e, `/laboratorio/ejecuciones?componente=${encodeURIComponent(componente)}&limite=500`)) as Ejecucion[]).filter((x) => metrica in x.metricas).reverse();
        const valores = d.map((x) => x.metricas[metrica] ?? null);
        salida(d.map((x) => ({ inicio: x.inicio, [metrica]: x.metricas[metrica] })), () => (d.length
          ? `${componente}.${metrica}  ${sparkline(valores)}  ${valores[valores.length - 1] ?? '—'}  (${d.length} ejecuciones, ${d[0]!.inicio.slice(0, 10)} → ${d[d.length - 1]!.inicio.slice(0, 10)})`
          : `No hay «${metrica}» en las ejecuciones de «${componente}»`));
        return 0;
      }
      e.escribir('uso: kj lab ls | run <componente|todos> | informe <componente> | historial <componente> <métrica>');
      return 2;
    }
    case 'grafica': {
      const q = `?dias=${encodeURIComponent(opcion(args, 'dias') ?? '0')}&perfil=${encodeURIComponent(opcion(args, 'perfil') ?? 'todos')}`;
      if (sub === 'acierto' || sub === 'eficiencia') {
        const d = (await pedir(e, `/analytics/eficiencia${q}`)) as { kpis: { tareas: number; acierto: number; retrabajo: number }; agentes: { agente: string; tareas: number; acierto: number; retrabajo: number; p50: number | null; coste_total: number }[] };
        salida(d, () => sub === 'acierto'
          ? `Acierto por agente (global ${pct(d.kpis.acierto)}, re-trabajo ${pct(d.kpis.retrabajo)}, ${d.kpis.tareas} tareas)\n${barras(d.agentes.map((a) => ({ etiqueta: a.agente, valor: a.acierto, nota: `${a.tareas} tareas` })), { formato: pct })}`
          : `Latencia p50 por agente (s)\n${barras(d.agentes.map((a) => ({ etiqueta: a.agente, valor: a.p50 === null ? null : a.p50 / 1000, nota: `coste ${a.coste_total} $` })), { formato: (x) => x.toFixed(1) })}`);
        return 0;
      }
      if (sub === 'flujo') {
        const d = (await pedir(e, `/analytics/flujo${q}`)) as { nodos: { nombre: string; capa: string; valor: number }[]; total: number };
        const capas = [...new Set(d.nodos.map((n) => n.capa))];
        salida(d, () => `Flujo de ${d.total} tareas\n${capas.map((c) => `${c}\n${barras(d.nodos.filter((n) => n.capa === c).map((n) => ({ etiqueta: `  ${n.nombre}`, valor: n.valor })))}`).join('\n')}`);
        return 0;
      }
      if (sub === 'matriz-skills') {
        const d = (await pedir(e, `/analytics/matriz-skills${q}`)) as { filas: { skill: string; usos: number; recomendada: number }[]; usadas: number; total: number };
        salida(d, () => `Skills: ${d.usadas} usadas de ${d.total}\n${barras(d.filas.slice(0, 20).map((f) => ({ etiqueta: f.skill, valor: f.usos, nota: `recomendada ${f.recomendada}` })))}`);
        return 0;
      }
      if (sub === 'sugerencias') {
        const d = (await pedir(e, `/analytics/sugerencias${q}`)) as { sugerencias: { severidad: string; texto: string }[] };
        salida(d, () => d.sugerencias.map((s) => `[${s.severidad}] ${s.texto}`).join('\n') || 'Nada que mejorar.');
        return 0;
      }
      e.escribir('uso: kj grafica acierto|eficiencia|flujo|matriz-skills|sugerencias [--dias N] [--perfil activo|todos] [--json]');
      return 2;
    }
    case 'propuestas': {
      const d = (await pedir(e, '/laboratorio/propuestas')) as { clave: string; tarea: string; estado: string; titulo: string | null }[];
      salida(d, () => d.map((p) => `${p.tarea}  ${p.estado.padEnd(11)} ${p.titulo ?? p.clave}`).join('\n') || 'Karajan no ha propuesto nada todavía.');
      return 0;
    }
    case 'comparar': {
      const nombre = args.slice(1).find((a, i, v) => !a.startsWith('--') && v[i - 1] !== '--grupo') ?? '';
      const grupo = opcion(args, 'grupo');
      const d = (await pedir(e, `/laboratorio/comparar?skill=${encodeURIComponent(nombre)}&grupo=${encodeURIComponent(grupo ?? '')}`)) as { karajan?: Comparada; pruebas?: PruebaVista[]; skills?: Comparada[] } & Partial<Comparada>;
      salida(d, () => {
        if (d.karajan) return [pintarComparada(d.karajan), ...(d.pruebas?.length ? ['', 'Pruebas con feedback humano en los pares:', ...d.pruebas.map((p) => `  • ${p.nombre}: ${p.pares.map((x) => `${x.par} (${x.estrellas}★)`).join(', ')}`)] : [])].join('\n');
        if (d.skills) {
          const con = d.skills.filter((c) => c.percentil !== null).sort((a, b) => b.percentil! - a.percentil!);
          const sin = d.skills.filter((c) => c.percentil === null);
          return [`Percentil por estrellas propias dentro de su grupo (${con.length} de ${d.skills.length} skills comparables)`, barras(con.map((c) => ({ etiqueta: c.sujeto, valor: c.percentil, nota: `${c.grupoNombre} · puesto ${c.posicion}` })), { formato: (x) => `p${x}` }), '', `Sin dato (${sin.length}): ${sin.map((c) => `${c.sujeto} [${c.estado}]`).join(', ') || '—'}`].join('\n');
        }
        return pintarComparada(d as Comparada);
      });
      return 0;
    }
    default:
      e.escribir('kj componentes | lab ls|run|informe|historial | grafica <tipo> | comparar [<skill>|karajan] [--grupo g] | propuestas | modo   (--json en todos)');
      return cmd ? 2 : 0;
  }
}

// Solo como programa (`node kj.mjs`), no al importarlo (los tests empaquetan este módulo en el suyo).
if (process.argv[1] && /(^|[\\/])(kj|cli)\.(mjs|js|ts)$/.test(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = process.env['KARAJAN_API'] ?? `${(process.env['ATLAS_DEV_API'] ?? 'http://127.0.0.1:4100').replace(/\/$/, '')}/paquetes/karajan/api`;
  ejecutar(process.argv.slice(2), { fetch: fetch as unknown as Fetch, escribir: (s) => process.stdout.write(`${s}\n`), api })
    .then((c) => { process.exitCode = c; })
    .catch((err: Error) => { process.stderr.write(`kj: ${err.message}\n`); process.exitCode = 1; });
}
