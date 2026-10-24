import { writeFileSync } from 'node:fs';
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
 *   kj propuestas                           borradores abiertos por Karajan y su estado
 *   kj modo                                 producción o desarrollo
 */
type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
interface Entorno { fetch: Fetch; escribir: (s: string) => void; api: string; /** Escribe un fichero (para `--svg` y `--html` de `kj grafica`); sin él, esas opciones fallan. */ guardar?: (ruta: string, contenido: string) => void }

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

const xml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const COLORES = ':root{--kj-fondo:#ffffff;--kj-texto:#1f2933;--kj-tenue:#52606d;--kj-barra:#2563eb;--kj-pista:#e4e7eb}@media (prefers-color-scheme:dark){:root{--kj-fondo:#12161c;--kj-texto:#e4e7eb;--kj-tenue:#9aa5b1;--kj-barra:#60a5fa;--kj-pista:#2a323d}}';

/** La misma gráfica de `barras()` como SVG autocontenido (barras horizontales, sin dependencias; claro y oscuro por `prefers-color-scheme`). */
export function graficaSvg(titulo: string, filas: { etiqueta: string; valor: number | null; nota?: string }[], { formato = (x: number) => String(x) } = {}): string {
  const fila = 26, izq = 190, ancho = 300, alto = 48 + Math.max(1, filas.length) * fila;
  const max = Math.max(0, ...filas.map((f) => f.valor ?? 0)) || 1;
  const cuerpo = filas.length ? filas.map((f, i) => {
    const y = 40 + i * fila, n = f.valor === null ? 0 : Math.round((Math.max(0, f.valor) / max) * ancho);
    return `<text x="${izq - 8}" y="${y + 14}" text-anchor="end" class="kj-t">${xml(f.etiqueta.slice(0, 28))}</text><rect x="${izq}" y="${y}" width="${ancho}" height="16" rx="3" class="kj-pista"/><rect x="${izq}" y="${y}" width="${n}" height="16" rx="3" class="kj-barra"/><text x="${izq + ancho + 8}" y="${y + 13}" class="kj-t">${f.valor === null ? '—' : xml(formato(f.valor))}${f.nota ? ` · ${xml(f.nota)}` : ''}</text>`;
  }).join('') : `<text x="12" y="62" class="kj-t">(sin datos)</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 ${alto}" width="640" height="${alto}" role="img" aria-label="${xml(titulo)}"><title>${xml(titulo)}</title><style>${COLORES}.kj-fondo{fill:var(--kj-fondo)}.kj-t{fill:var(--kj-texto);font:13px system-ui,sans-serif}.kj-h{fill:var(--kj-tenue);font:600 14px system-ui,sans-serif}.kj-pista{fill:var(--kj-pista)}.kj-barra{fill:var(--kj-barra)}</style><rect width="640" height="${alto}" class="kj-fondo"/><text x="12" y="24" class="kj-h">${xml(titulo)}</text>${cuerpo}</svg>\n`;
}

/** La gráfica como HTML autocontenido: título, el SVG y una tabla con los mismos datos para lectores de pantalla. */
export function graficaHtml(titulo: string, filas: { etiqueta: string; valor: number | null; nota?: string }[], opciones: { formato?: (x: number) => string } = {}): string {
  const formato = opciones.formato ?? ((x: number) => String(x));
  const tabla = filas.map((f) => `<tr><th scope="row">${xml(f.etiqueta)}</th><td>${f.valor === null ? '—' : xml(formato(f.valor))}</td><td>${xml(f.nota ?? '')}</td></tr>`).join('');
  return `<!doctype html>\n<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${xml(titulo)}</title><style>${COLORES}body{margin:0;padding:16px;background:var(--kj-fondo);color:var(--kj-texto);font:15px system-ui,sans-serif}h1{font-size:1.2rem}svg{max-width:100%;height:auto}table{border-collapse:collapse;margin-top:16px}caption{text-align:left;color:var(--kj-tenue);padding-bottom:4px}th,td{border-bottom:1px solid var(--kj-pista);padding:4px 12px;text-align:left}</style></head><body><main><h1>${xml(titulo)}</h1>${graficaSvg(titulo, filas, { formato })}<table><caption>Datos de la gráfica</caption><thead><tr><th scope="col">Etiqueta</th><th scope="col">Valor</th><th scope="col">Nota</th></tr></thead><tbody>${tabla}</tbody></table></main></body></html>\n`;
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
      // `--svg <fichero>` y `--html <fichero>` guardan la misma gráfica (por `e.guardar`); devuelve el código de salida, o null si no se pidió.
      const [svg, html] = [opcion(args, 'svg'), opcion(args, 'html')];
      const exportar = (titulo: string, filas: { etiqueta: string; valor: number | null; nota?: string }[], formato?: (x: number) => string): number | null => {
        if (svg === null && html === null) return null;
        if (!e.guardar || svg === '' || html === '' || sub === 'sugerencias') { e.escribir('uso: kj grafica acierto|eficiencia|flujo|matriz-skills [--svg <fichero>] [--html <fichero>]'); return 2; }
        if (svg) e.guardar(svg, graficaSvg(titulo, filas, { formato }));
        if (html) e.guardar(html, graficaHtml(titulo, filas, { formato }));
        e.escribir(`Gráfica guardada en ${[svg, html].filter(Boolean).join(' y ')}`);
        return 0;
      };
      if (sub === 'acierto' || sub === 'eficiencia') {
        const d = (await pedir(e, `/analytics/eficiencia${q}`)) as { kpis: { tareas: number; acierto: number; retrabajo: number }; agentes: { agente: string; tareas: number; acierto: number; retrabajo: number; p50: number | null; coste_total: number }[] };
        const exp = sub === 'acierto'
          ? exportar(`Acierto por agente (global ${pct(d.kpis.acierto)}, ${d.kpis.tareas} tareas)`, d.agentes.map((a) => ({ etiqueta: a.agente, valor: a.acierto, nota: `${a.tareas} tareas` })), pct)
          : exportar('Latencia p50 por agente (s)', d.agentes.map((a) => ({ etiqueta: a.agente, valor: a.p50 === null ? null : a.p50 / 1000, nota: `coste ${a.coste_total} $` })), (x) => x.toFixed(1));
        if (exp !== null) return exp;
        salida(d, () => sub === 'acierto'
          ? `Acierto por agente (global ${pct(d.kpis.acierto)}, re-trabajo ${pct(d.kpis.retrabajo)}, ${d.kpis.tareas} tareas)\n${barras(d.agentes.map((a) => ({ etiqueta: a.agente, valor: a.acierto, nota: `${a.tareas} tareas` })), { formato: pct })}`
          : `Latencia p50 por agente (s)\n${barras(d.agentes.map((a) => ({ etiqueta: a.agente, valor: a.p50 === null ? null : a.p50 / 1000, nota: `coste ${a.coste_total} $` })), { formato: (x) => x.toFixed(1) })}`);
        return 0;
      }
      if (sub === 'flujo') {
        const d = (await pedir(e, `/analytics/flujo${q}`)) as { nodos: { nombre: string; capa: string; valor: number }[]; total: number };
        const capas = [...new Set(d.nodos.map((n) => n.capa))];
        const expFlujo = exportar(`Flujo de ${d.total} tareas`, d.nodos.map((n) => ({ etiqueta: `${n.capa} · ${n.nombre}`, valor: n.valor })));
        if (expFlujo !== null) return expFlujo;
        salida(d, () => `Flujo de ${d.total} tareas\n${capas.map((c) => `${c}\n${barras(d.nodos.filter((n) => n.capa === c).map((n) => ({ etiqueta: `  ${n.nombre}`, valor: n.valor })))}`).join('\n')}`);
        return 0;
      }
      if (sub === 'matriz-skills') {
        const d = (await pedir(e, `/analytics/matriz-skills${q}`)) as { filas: { skill: string; usos: number; recomendada: number }[]; usadas: number; total: number };
        const expSkills = exportar(`Skills: ${d.usadas} usadas de ${d.total}`, d.filas.slice(0, 20).map((f) => ({ etiqueta: f.skill, valor: f.usos, nota: `recomendada ${f.recomendada}` })));
        if (expSkills !== null) return expSkills;
        salida(d, () => `Skills: ${d.usadas} usadas de ${d.total}\n${barras(d.filas.slice(0, 20).map((f) => ({ etiqueta: f.skill, valor: f.usos, nota: `recomendada ${f.recomendada}` })))}`);
        return 0;
      }
      if (sub === 'sugerencias') {
        if (exportar('', []) !== null) return 2;
        const d = (await pedir(e, `/analytics/sugerencias${q}`)) as { sugerencias: { severidad: string; texto: string }[] };
        salida(d, () => d.sugerencias.map((s) => `[${s.severidad}] ${s.texto}`).join('\n') || 'Nada que mejorar.');
        return 0;
      }
      e.escribir('uso: kj grafica acierto|eficiencia|flujo|matriz-skills|sugerencias [--dias N] [--perfil activo|todos] [--json] [--svg <fichero>] [--html <fichero>]');
      return 2;
    }
    case 'propuestas': {
      const d = (await pedir(e, '/laboratorio/propuestas')) as { clave: string; tarea: string; estado: string; titulo: string | null }[];
      salida(d, () => d.map((p) => `${p.tarea}  ${p.estado.padEnd(11)} ${p.titulo ?? p.clave}`).join('\n') || 'Karajan no ha propuesto nada todavía.');
      return 0;
    }
    default:
      e.escribir('kj componentes | lab ls|run|informe|historial | grafica <tipo> | propuestas | modo   (--json en todos)');
      return cmd ? 2 : 0;
  }
}

// Solo como programa (`node kj.mjs`), no al importarlo (los tests empaquetan este módulo en el suyo).
if (process.argv[1] && /(^|[\\/])(kj|cli)\.(mjs|js|ts)$/.test(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = process.env['KARAJAN_API'] ?? `${(process.env['ATLAS_DEV_API'] ?? 'http://127.0.0.1:4100').replace(/\/$/, '')}/paquetes/karajan/api`;
  ejecutar(process.argv.slice(2), { fetch: fetch as unknown as Fetch, escribir: (s) => process.stdout.write(`${s}\n`), api, guardar: (ruta, contenido) => writeFileSync(ruta, contenido, 'utf8') })
    .then((c) => { process.exitCode = c; })
    .catch((err: Error) => { process.stderr.write(`kj: ${err.message}\n`); process.exitCode = 1; });
}
