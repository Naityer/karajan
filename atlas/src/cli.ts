import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import paquete from '../../atlas-package.json';
import { barras, sparkline } from './sdk/ascii';
import { crearRegistro } from './sdk/registro';
import { renderAscii, renderJson } from './sdk/panel';
import { normalizarConfig, normalizarEstado } from './dosificador-config';
import { simularSolicitud } from './dosificador-sim';
import { decidirSolicitud } from './dosificador';
import { validarLayout, proyectar } from './perfiles';
import { Perfiles } from './perfiles';
import { configDesde } from './heuristica';
import { Delegador } from './delegar';
import { Biblioteca, consultarBiblioteca } from './biblioteca';
import { Almacen, consultarTareas } from './almacen';
import { abrirBibliotecaLocal, produccionLocal, proveedoresLocales } from './cli-local';
import { CAPAS, COMPONENTES, catalogoComponentes, componente as buscarComponente } from './componentes';
import { consultarComparacion } from './comparador';
import { descubrirSkills } from './skills-seleccion';
import { argumentosPosicionales } from './sdk/comandos';
import { ejecutarLaboratorio, leerEjecucionesDe, leerEjecucionesLocal, RegistroLab } from './laboratorio';

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
 *   kj curador [--proponer]                 skills que sobran, por regla; --proponer las abre como borradores
 *   kj comparar [<skill>|karajan] [--grupo g]  cada skill (o Karajan) frente a las mejores de su grupo, con estrellas propias
 *   kj dosificador estado|config|decidir|simular   cuándo, dónde y con qué agente se lanza cada tarea (cuota por agente, circuitos, simulación)
 *   kj propuestas                           borradores abiertos por Karajan y su estado
 *   kj modo                                 producción o desarrollo
 */
type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
interface Entorno { fetch: Fetch; escribir: (s: string) => void; api: string; localPorDefecto?: boolean; /** Escribe un fichero (para `--svg` y `--html` de `kj grafica`); sin él, esas opciones fallan. */ guardar?: (ruta: string, contenido: string) => void;
  /** Lee un fichero (para `kj dosificador decidir --entrada`); sin él, esa opción falla. */ leer?: (ruta: string) => string }

export { barras, sparkline };

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
/** Cada ruta explícita prevalece; un directorio también explícito evita duplicar opciones. */
const rutaLocal = (args: string[], opcionNombre: string, variable: string, carpeta: string | undefined, ...partes: string[]) =>
  opcion(args, opcionNombre) ?? process.env[variable] ?? (carpeta ? join(carpeta, ...partes) : undefined);

async function pedir(e: Entorno, ruta: string, metodo = 'GET', cuerpo?: unknown, tarea?: string | null): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // En producción toda escritura necesita una tarea aceptada de Atlas dev (modo.ts): `--tarea <id>` o KARAJAN_TAREA.
  const t = tarea ?? process.env['KARAJAN_TAREA'];
  if (t) headers['x-karajan-tarea'] = t;
  if (process.env['ATLAS_DEV_TOKEN']) headers['x-atlas-dev-token'] = process.env['ATLAS_DEV_TOKEN'];
  let r: Awaited<ReturnType<Fetch>>;
  try { r = await e.fetch(`${e.api}${ruta}`, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) }); }
  catch { throw new Error(`No se puede conectar con Karajan en ${e.api}; esta operación necesita el servicio HTTP configurado`); }
  const datos = await r.json().catch(() => null);
  if (!r.ok) {
    const fallo = datos as { detail?: string; error?: string } | null;
    throw new Error(`${r.status}: ${fallo?.detail ?? fallo?.error ?? 'error'}`);
  }
  return datos;
}

interface ComponenteVista { id: string; capa: string; responsabilidad: string; pendiente: string | null; escenarios: { id: string; tipo: string; descripcion: string }[]; ultimas: { escenario: string; inicio: string; muestra: number; suficiente: boolean; hallazgos: number; error: string | null; metricas: Record<string, number | null> }[] }
interface Ejecucion { escenario: string; tipo: string; inicio: string; muestra: number; suficiente: boolean; metricas: Record<string, number | null>; hallazgos: { severidad: string; titulo: string }[]; error: string | null; propuestas?: { accion: string; tarea: string | null }[] }

function catalogoLocal(ruta: string): ComponenteVista[] {
  if (!existsSync(ruta)) throw new Error('la base no existe');
  const db = new DatabaseSync(ruta, { readOnly: true });
  try {
    const ultimas = (id: string) => {
      const vistos = new Set<string>();
      return leerEjecucionesDe(db, id, 100).filter((f) => !vistos.has(f.escenario) && vistos.add(f.escenario))
        .map((f) => ({ escenario: f.escenario, inicio: f.inicio, muestra: f.muestra, suficiente: f.suficiente, hallazgos: f.hallazgos.length, error: f.error, metricas: f.metricas }));
    };
    return catalogoComponentes(ultimas) as ComponenteVista[];
  } finally { db.close(); }
}

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

/** `<componente> <acción>` que ya tienen un comando propio en el despachador de abajo. */
const PROPIOS = new Set(['dosificador config']);

export async function ejecutar(args: string[], e: Entorno): Promise<number> {
  const [cmd, sub, ...resto] = args;
  const json = bandera(args, 'json');
  const datos = opcion(args, 'datos') ?? process.env['KARAJAN_DATA_DIR'];
  const datosAtlas = opcion(args, 'datos-atlas') ?? process.env['KARAJAN_ATLAS_DATA_DIR'];
  const rutaLayout = () => rutaLocal(args, 'layout', 'KARAJAN_ROUTING_LAYOUT', datos, 'routing_layout.json');
  const rutaTareas = () => rutaLocal(args, 'tasks-db', 'KARAJAN_TASKS_DB', datos, 'task_logs.db');
  const rutaLab = () => rutaLocal(args, 'lab-db', 'KARAJAN_LAB_DB', datosAtlas, 'laboratorio', 'laboratorio.db');
  const rutaConfig = () => rutaLocal(args, 'config', 'KARAJAN_DOSIFICADOR_CONFIG', datosAtlas, 'dosificador.json');
  const rutaEstado = () => rutaLocal(args, 'estado', 'KARAJAN_DOSIFICADOR_ESTADO', datosAtlas, 'dosificador-estado.json');
  const rutaRecursos = () => opcion(args, 'resources-db') ?? process.env['KARAJAN_RESOURCES_DB'] ?? process.env['ATLAS_KARAJAN_RESOURCES'] ?? (datos ? join(datos, 'resources.db') : undefined);
  if (bandera(args, 'local') && bandera(args, 'http')) { e.escribir('Elige --local o --http, no ambos'); return 2; }
  if (bandera(args, 'local') && !(cmd === 'modo' || cmd === 'inspiration' || cmd === 'grafica' || cmd === 'comparar' || (cmd === 'estadisticas' && ['tareas', 'tarea', 'resumen', 'agentes', 'skills'].includes(sub ?? '')) || (cmd === 'control' && (['perfiles', 'jerarquia', 'proveedores'].includes(sub ?? '') || (sub === 'mision' && !bandera(args, 'ejecutar')))) || (cmd === 'componentes' && (!sub || sub.startsWith('--'))) || (cmd === 'lab' && ['ls', 'run', 'informe', 'historial'].includes(sub ?? '')) || (cmd === 'dosificador' && ['simular', 'decidir', 'config'].includes(sub ?? '')))) {
    e.escribir('Esta operación no está disponible en modo local; usa --http para conectar con Atlas dev'); return 2;
  }
  const salida = (datos: unknown, texto: () => string) => e.escribir(json ? JSON.stringify(datos, null, 2) : texto());
  // Módulos y comandos genéricos de componente (sdk/): devuelven un Panel que se pinta en ASCII o en JSON.
  const registro = crearRegistro();
  const encontrado = registro.resolver(args);
  // Los comandos propios de un componente (`kj dosificador config`, que además escribe) mandan sobre los genéricos de `<componente> <acción>`.
  const propio = encontrado?.comando.ruta[0] === '*' && PROPIOS.has(`${args[0]} ${args[1]}`);
  if (encontrado && !propio) {
    const localPerfil = cmd === 'control' && ['perfiles', 'jerarquia'].includes(sub ?? '') && (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http')));
    const localProveedores = cmd === 'control' && sub === 'proveedores' && (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http')));
    const localMision = cmd === 'control' && sub === 'mision' && !bandera(args, 'ejecutar') && (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http')));
    const localBiblioteca = cmd === 'inspiration' && (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http')));
    const localTareas = cmd === 'estadisticas' && ['tareas', 'tarea', 'resumen', 'agentes', 'skills'].includes(sub ?? '') && (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http')));
    let layout: unknown;
    if (localPerfil) {
      const fichero = rutaLayout();
      if (!fichero || !e.leer) { e.escribir('control local necesita --layout <routing_layout.json> o KARAJAN_ROUTING_LAYOUT'); return 2; }
      try { layout = { ...proyectar(validarLayout(JSON.parse(e.leer(fichero)))), path: fichero }; }
      catch (err) { e.escribir(`No se puede leer el perfil en ${fichero}: ${(err as Error).message}`); return 2; }
    }
    let biblioteca: Biblioteca | null = null;
    let almacen: Almacen | null = null;
    if (localBiblioteca) {
      const archivo = rutaRecursos();
      if (!archivo || !existsSync(archivo)) { e.escribir('inspiration local necesita --resources-db <resources.db> existente'); return 2; }
      try { biblioteca = abrirBibliotecaLocal(archivo); } catch (err) { e.escribir(`No se puede abrir resources.db: ${(err as Error).message}`); return 2; }
    }
    if (localTareas || localMision) {
      const archivo = rutaTareas();
      if (!archivo) { e.escribir('estadisticas local necesita --tasks-db <task_logs.db> o KARAJAN_TASKS_DB'); return 2; }
      try { almacen = new Almacen(archivo, { soloLectura: true }); }
      catch (err) { e.escribir(`No se puede abrir task_logs.db: ${(err as Error).message}`); return 2; }
    }
    try {
      const panel = await encontrado.comando.ejecutar({ pedir: async (ruta, metodo, cuerpo) => {
        if (localPerfil) { if (ruta === '/routing-layout' && (!metodo || metodo === 'GET')) return layout; throw new Error('Operación no disponible en modo local'); }
        if (localProveedores) { if (ruta === '/providers' && (!metodo || metodo === 'GET')) return proveedoresLocales(); throw new Error('Operación no disponible en modo local'); }
        if (localMision) {
          if (ruta !== '/routing/plan' || metodo !== 'POST') throw new Error('La planificación local no ejecuta agentes');
          const fichero = rutaLayout(), cfgRuta = datos ? join(datos, 'active_config.json') : undefined;
          if (!fichero || !cfgRuta || !e.leer) throw new Error('mision local necesita --datos con active_config.json y --layout');
          validarLayout(JSON.parse(e.leer(fichero)));
          const cfg = JSON.parse(e.leer(cfgRuta));
          if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('active_config.json no es un objeto válido');
          const prompt = (cuerpo as { prompt?: unknown } | null)?.prompt;
          if (typeof prompt !== 'string' || !prompt.trim() || prompt.trim().length > 20_000) throw new Error('prompt vacío o demasiado largo (máx. 20000 caracteres)');
          return new Delegador({ almacen: almacen!, perfiles: new Perfiles(fichero), config: () => configDesde(cfg), raiz: process.cwd() }).planificar(prompt.trim());
        }
        if (localBiblioteca) {
          if (metodo && metodo !== 'GET') throw new Error('La biblioteca local solo admite lectura');
          const url = new URL(ruta, 'http://localhost');
          return consultarBiblioteca(biblioteca!, url.pathname, Object.fromEntries(url.searchParams));
        }
        if (localTareas) {
          if (metodo && metodo !== 'GET') throw new Error('Las tareas locales solo admiten lectura');
          const url = new URL(ruta, 'http://localhost');
          if (url.pathname === '/analytics/produccion') {
            const q = Object.fromEntries(url.searchParams);
            const p = produccionLocal(almacen!, q, e.leer, rutaLayout());
            const { acierto: _acierto, ...resultado } = p;
            return resultado;
          }
          return consultarTareas(almacen!, url.pathname, Object.fromEntries(url.searchParams));
        }
        return pedir(e, ruta, metodo, cuerpo, opcion(args, 'tarea'));
      }, opcion: (n) => opcion(args, n), bandera: (n) => bandera(args, n) }, encontrado.resto, encontrado.ruta);
      e.escribir(json ? renderJson(panel) : renderAscii(panel));
      return 0;
    } finally { biblioteca?.cerrar(); almacen?.cerrar(); }
  }
  switch (cmd) {
    case 'modo': {
      let m: { modo: string; fichero: string };
      if (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http'))) {
        if (!datos || !e.leer) { e.escribir('modo local necesita --datos <directorio> o KARAJAN_DATA_DIR'); return 2; }
        const fichero = join(datos, 'modo.json');
        try { const modo = JSON.parse(e.leer(fichero)).modo; if (!['produccion', 'desarrollo'].includes(modo)) throw new Error(); m = { modo, fichero }; }
        catch { e.escribir(`No se puede leer un modo válido en ${fichero}`); return 2; }
      } else m = (await pedir(e, '/laboratorio/modo')) as { modo: string; fichero: string };
      salida(m, () => `Karajan en ${m.modo.toUpperCase()}${m.modo === 'produccion' ? ': los cambios necesitan una tarea aceptada; el resto se propone como borrador.' : '.'}\n(${m.fichero}, solo se cambia editando el fichero)`);
      return 0;
    }
    case 'componentes': {
      let d: { version: string; modo: string; capas: { id: string; nombre: string }[]; componentes: ComponenteVista[] };
      if (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http'))) {
        const lab = rutaLab();
        if (!datos || !lab || !e.leer) { e.escribir('componentes local necesita --datos <directorio> y --lab-db <laboratorio.db> (o KARAJAN_DATA_DIR y KARAJAN_LAB_DB)'); return 2; }
        let modo: string;
        try { const valor = JSON.parse(e.leer(join(datos, 'modo.json'))); if (!['produccion', 'desarrollo'].includes(valor.modo)) throw new Error(); modo = valor.modo; }
        catch { e.escribir('No se puede leer modo.json válido en el directorio de datos'); return 2; }
        try {
          d = { version: paquete.version, modo, capas: CAPAS, componentes: catalogoLocal(lab) };
        } catch (err) { e.escribir(`No se puede leer el laboratorio en ${lab}: ${(err as Error).message}`); return 2; }
      } else d = (await pedir(e, '/laboratorio/componentes')) as typeof d;
      salida(d, () => [`Karajan ${d.version} · ${d.modo}`, ...d.capas.flatMap((capa) => {
        const cs = d.componentes.filter((c) => c.capa === capa.id);
        return [`┌ ${capa.nombre}`, ...cs.map((c) => `│ ${c.id.padEnd(13)} ${estadoDe(c).padEnd(26)} ${c.responsabilidad}`)];
      }), '└'].join('\n'));
      return 0;
    }
    case 'lab': {
      if (sub === 'ls') {
        const local = bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http'));
        let d: { componentes: ComponenteVista[] };
        if (local) {
          const lab = rutaLab();
          try { d = { componentes: lab ? catalogoLocal(lab) : catalogoComponentes() as ComponenteVista[] }; }
          catch (err) { e.escribir(`No se puede leer el laboratorio en ${lab}: ${(err as Error).message}`); return 2; }
        } else d = (await pedir(e, '/laboratorio/componentes')) as { componentes: ComponenteVista[] };
        salida(d.componentes, () => d.componentes.map((c) => c.escenarios.length
          ? `${c.id}\n${c.escenarios.map((s) => `  ${s.id.padEnd(22)} ${s.tipo.padEnd(9)} ${s.descripcion}`).join('\n')}`
          : `${c.id}  — ${c.pendiente ?? 'sin laboratorio'}`).join('\n'));
        return 0;
      }
      if (sub === 'run') {
        const componente = resto.find((a) => !a.startsWith('--')) ?? '';
        if (!componente) { e.escribir('uso: kj lab run <componente|todos> [--escenario x] [--sin-borradores]'); return 2; }
        let d: { informes: { componente: string; escenarios: Ejecucion[] }[] };
        if (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http') && componente === 'dosificador' && bandera(args, 'sin-borradores'))) {
          if (componente !== 'dosificador' || !bandera(args, 'sin-borradores')) { e.escribir('El laboratorio local solo admite dosificador con --sin-borradores; usa --http para los demás casos'); return 2; }
          const cfgRuta = rutaConfig();
          const lab = rutaLab();
          if (!cfgRuta || !lab || !e.leer || !existsSync(lab)) { e.escribir('lab local necesita --config y --lab-db existentes'); return 2; }
          let cfg: unknown;
          try { cfg = JSON.parse(e.leer(cfgRuta)); } catch { e.escribir('No se puede leer la configuración del dosificador'); return 2; }
          if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { e.escribir('La configuración debe ser un objeto JSON'); return 2; }
          let db: DatabaseSync | null = null;
          try {
            db = new DatabaseSync(lab, { readOnly: true });
            const columnas = db.prepare('PRAGMA table_info(lab_ejecuciones)').all() as { name: string }[];
            if (!columnas.some((c) => c.name === 'umbrales_json')) throw new Error('esquema de laboratorio no compatible');
          } catch (err) { e.escribir(`No se puede usar la base de laboratorio: ${(err as Error).message}`); return 2; }
          finally { db?.close(); }
          const registro = new RegistroLab(lab);
          try {
            const c = buscarComponente('dosificador')!;
            const contexto = { config: () => normalizarConfig(cfg), tareas: async () => { throw new Error('Atlas no disponible en modo local'); }, calibraciones: () => [] };
            d = { informes: [await ejecutarLaboratorio({ id: c.id, version: paquete.version, laboratorio: c.laboratorio! }, contexto, registro, { escenario: opcion(args, 'escenario'), pasarela: null })] };
          } finally { registro.cerrar(); }
        } else d = (await pedir(e, '/laboratorio/ejecutar', 'POST', { componente, escenario: opcion(args, 'escenario'), proponer: !bandera(args, 'sin-borradores') })) as typeof d;
        salida(d, () => d.informes.map((i) => `${i.componente}\n${i.escenarios.map(pintarEjecucion).join('\n')}`).join('\n\n'));
        return 0;
      }
      if (sub === 'informe') {
        const componente = resto[0] ?? '';
        const local = bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http'));
        const ruta = rutaLab();
        if (local && !ruta) { e.escribir('El historial local necesita --lab-db <laboratorio.db> o KARAJAN_LAB_DB'); return 2; }
        const d = local ? leerEjecucionesLocal(ruta!, componente, 100) : (await pedir(e, `/laboratorio/ejecuciones?componente=${encodeURIComponent(componente)}&limite=100`)) as Ejecucion[];
        const vistos = new Set<string>();
        const ultimas = d.filter((x) => !vistos.has(x.escenario) && vistos.add(x.escenario));
        salida(ultimas, () => (ultimas.length ? `${componente} · ${ultimas[0]!.inicio.slice(0, 16).replace('T', ' ')}\n${ultimas.map(pintarEjecucion).join('\n')}` : `Sin ejecuciones de «${componente}»: kj lab run ${componente}`));
        return 0;
      }
      if (sub === 'historial') {
        const [componente = '', metrica = ''] = resto;
        const local = bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http'));
        const ruta = rutaLab();
        if (local && !ruta) { e.escribir('El historial local necesita --lab-db <laboratorio.db> o KARAJAN_LAB_DB'); return 2; }
        const d = (local ? leerEjecucionesLocal(ruta!, componente, 500) : (await pedir(e, `/laboratorio/ejecuciones?componente=${encodeURIComponent(componente)}&limite=500`)) as Ejecucion[]).filter((x) => metrica in x.metricas).reverse();
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
      const local = bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http'));
      const pedirGrafica = async (ruta: string) => {
        if (!local) return pedir(e, ruta);
        const archivo = rutaTareas();
        if (!archivo) throw new Error('gráfica local necesita --tasks-db <task_logs.db> o KARAJAN_TASKS_DB');
        const almacen = new Almacen(archivo, { soloLectura: true });
        try {
          const url = new URL(ruta, 'http://localhost');
          const p = produccionLocal(almacen, Object.fromEntries(url.searchParams), e.leer, rutaLayout());
          const base = { dias: p.dias, perfil: p.perfil, agentes_perfil: p.agentes_perfil, ultima: p.ultima, kpis: p.kpis };
          if (url.pathname === '/analytics/flujo') return { ...base, ...p.flujo };
          if (url.pathname === '/analytics/eficiencia') return { ...base, ...p.eficiencia };
          if (url.pathname === '/analytics/matriz-skills') return { ...base, ...p.matriz };
          if (url.pathname === '/analytics/sugerencias') return { ...base, sugerencias: p.sugerencias };
          throw new Error('Gráfica no disponible en modo local');
        } finally { almacen.cerrar(); }
      };
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
        const d = (await pedirGrafica(`/analytics/eficiencia${q}`)) as { kpis: { tareas: number; acierto: number; retrabajo: number }; agentes: { agente: string; tareas: number; acierto: number; retrabajo: number; p50: number | null; coste_total: number }[] };
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
        const d = (await pedirGrafica(`/analytics/flujo${q}`)) as { nodos: { nombre: string; capa: string; valor: number }[]; total: number };
        const capas = [...new Set(d.nodos.map((n) => n.capa))];
        const expFlujo = exportar(`Flujo de ${d.total} tareas`, d.nodos.map((n) => ({ etiqueta: `${n.capa} · ${n.nombre}`, valor: n.valor })));
        if (expFlujo !== null) return expFlujo;
        salida(d, () => `Flujo de ${d.total} tareas\n${capas.map((c) => `${c}\n${barras(d.nodos.filter((n) => n.capa === c).map((n) => ({ etiqueta: `  ${n.nombre}`, valor: n.valor })))}`).join('\n')}`);
        return 0;
      }
      if (sub === 'matriz-skills') {
        const d = (await pedirGrafica(`/analytics/matriz-skills${q}`)) as { filas: { skill: string; usos: number; recomendada: number }[]; usadas: number; total: number };
        const expSkills = exportar(`Skills: ${d.usadas} usadas de ${d.total}`, d.filas.slice(0, 20).map((f) => ({ etiqueta: f.skill, valor: f.usos, nota: `recomendada ${f.recomendada}` })));
        if (expSkills !== null) return expSkills;
        salida(d, () => `Skills: ${d.usadas} usadas de ${d.total}\n${barras(d.filas.slice(0, 20).map((f) => ({ etiqueta: f.skill, valor: f.usos, nota: `recomendada ${f.recomendada}` })))}`);
        return 0;
      }
      if (sub === 'sugerencias') {
        if (exportar('', []) !== null) return 2;
        const d = (await pedirGrafica(`/analytics/sugerencias${q}`)) as { sugerencias: { severidad: string; texto: string }[] };
        salida(d, () => d.sugerencias.map((s) => `[${s.severidad}] ${s.texto}`).join('\n') || 'Nada que mejorar.');
        return 0;
      }
      e.escribir('uso: kj grafica acierto|eficiencia|flujo|matriz-skills|sugerencias [--dias N] [--perfil activo|todos] [--json] [--svg <fichero>] [--html <fichero>]');
      return 2;
    }
    case 'curador': {
      interface PropuestaCurador { skill: string; regla: string; evidencia: string; accion: string; borrador?: { tarea: string | null; accion: string } }
      const proponer = bandera(args, 'proponer');
      const d = proponer ? (await pedir(e, '/laboratorio/curador/proponer', 'POST', {})) as { propuestas: PropuestaCurador[] } : (await pedir(e, '/laboratorio/curador')) as { propuestas: PropuestaCurador[] };
      salida(d, () => {
        const reglas = [...new Set(d.propuestas.map((p) => p.regla))];
        if (!reglas.length) return 'El curador no propone nada: no sobra ninguna skill.';
        return reglas.map((r) => {
          const ps = d.propuestas.filter((p) => p.regla === r);
          return `${r} (${ps[0]!.accion}) · ${ps.length}\n${ps.map((p) => `  ${p.skill}  ${p.evidencia}${p.borrador?.tarea ? `  → borrador ${p.borrador.tarea} (${p.borrador.accion})` : ''}`).join('\n')}`;
        }).join('\n\n');
      });
      return 0;
    }
    case 'dosificador': {
      // kj dosificador estado | config [--set '<json>'] | decidir --entrada <fichero.json> | simular [--semanas N] [--semilla S] [--demanda X]
      interface InfoAg { datos: string; usadoPct: number | null; usadoSesionPct: number | null; reinicio: number | null; techoPct: number | null; presupuestoPct: number | null; comprometidoPct: number; lineaPct: number | null; errorPct: number | null; modo: string; burn: number | null; agotamiento: string | null; circuitoHasta: number | null }
      const n1 = (x: number | null | undefined, sufijo = ' %') => (x === null || x === undefined ? '—' : `${Math.round(x * 10) / 10}${sufijo}`);
      const hora = (ms: number | null) => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 16).replace('T', ' '));
      if (sub === undefined || sub === 'estado') {
        const d = (await pedir(e, '/dosificador/estado')) as { ahora: string; modo: string; burn: number | null; agotamiento: string | null; circuitos: Record<string, boolean>; simulacion: boolean; agentes: Record<string, InfoAg>; ultima_decision: { en: string; decisiones: number; diferidas: number } | null; en_vuelo: { tarea: string; agente: string; equipo: string; coste_p80_pct: number; lanzar_en: string | null }[]; clases_aprendidas: number };
        salida(d, () => [
          `Dosificador · ${d.modo.toUpperCase()}${d.simulacion ? ' · SIMULACIÓN' : ''} · uso ${n1(d.burn, ' %/h')} · agotamiento ${d.agotamiento?.slice(0, 16).replace('T', ' ') ?? 'no antes del reinicio'} · ${d.clases_aprendidas} clases aprendidas`,
          ...Object.entries(d.agentes).map(([a, x]) => `  ${a.padEnd(7)} ${x.datos === 'ok' ? '' : `[${x.datos}] `}semanal ${n1(x.usadoPct)} (techo ${n1(x.techoPct)}, libre ${n1(x.presupuestoPct)}, en vuelo ${n1(x.comprometidoPct)}) · línea ${n1(x.lineaPct)} · 5 h ${n1(x.usadoSesionPct)} · ${x.modo} · reinicio ${hora(x.reinicio)}${x.circuitoHasta ? ` · CIRCUITO ABIERTO hasta ${hora(x.circuitoHasta)}` : ''}`),
          d.ultima_decision ? `Última decisión ${d.ultima_decision.en.slice(0, 16).replace('T', ' ')}: ${d.ultima_decision.decisiones} decididas, ${d.ultima_decision.diferidas} diferidas` : 'Sin decisiones todavía.',
          ...(d.en_vuelo.length ? ['En vuelo:', ...d.en_vuelo.map((t) => `  ${t.tarea} → ${t.agente}/${t.equipo} (${n1(t.coste_p80_pct)}${t.lanzar_en ? `, sale ${t.lanzar_en.slice(11, 16)}` : ''})`)] : []),
        ].join('\n'));
        return 0;
      }
      if (sub === 'config') {
        const nuevo = opcion(args, 'set');
        if (nuevo === '') { e.escribir('uso: kj dosificador config [--set \'{"margenSeguridadPct": 12}\']'); return 2; }
        let parcial: unknown;
        try { parcial = nuevo === null ? undefined : JSON.parse(nuevo); } catch { e.escribir('--set: JSON no válido'); return 2; }
        let d: { config: Record<string, unknown>; fichero: string };
        const local = bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http') && parcial === undefined);
        if (local) {
          if (parcial !== undefined) { e.escribir('La modificación de configuración necesita --http y los controles de Atlas'); return 2; }
          const fichero = rutaConfig();
          if (!fichero || !e.leer) { e.escribir('config local necesita --config <dosificador.json>'); return 2; }
          try { const raw = JSON.parse(e.leer(fichero)); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(); d = { config: normalizarConfig(raw) as unknown as Record<string, unknown>, fichero }; }
          catch { e.escribir(`No se puede leer la configuración en ${fichero}`); return 2; }
        } else d = (await (parcial === undefined ? pedir(e, '/dosificador/config') : pedir(e, '/dosificador/config', 'PUT', parcial, opcion(args, 'tarea')))) as typeof d;
        salida(d, () => `${d.fichero}\n${JSON.stringify(d.config, null, 2)}`);
        return 0;
      }
      if (sub === 'decidir') {
        const ruta = opcion(args, 'entrada');
        if (!ruta || !e.leer) { e.escribir('uso: kj dosificador decidir --entrada <fichero.json> [--json]   (decide sin guardar el estado)'); return 2; }
        let cuerpo: Record<string, unknown>;
        try { cuerpo = JSON.parse(e.leer(ruta)) as Record<string, unknown>; } catch { e.escribir(`${ruta}: no es un JSON legible`); return 2; }
        let d: { decisiones: { tarea: string; agente: string; equipo: string; lanzarEn: number | null; motivo: string }[]; diferidas: { tarea: string; hasta: number | null; motivo: string }[]; estado: { modo: string } };
        if (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http'))) {
          const cfgRuta = rutaConfig();
          const estadoRuta = rutaEstado();
          if (!cfgRuta || !estadoRuta) { e.escribir('decidir local necesita --config y --estado explícitos'); return 2; }
          let cfg: unknown, estado: unknown;
          try { cfg = JSON.parse(e.leer(cfgRuta)); estado = JSON.parse(e.leer(estadoRuta)); } catch { e.escribir('No se puede leer la configuración o el estado del dosificador'); return 2; }
          if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !estado || typeof estado !== 'object' || Array.isArray(estado)) { e.escribir('La configuración y el estado deben ser objetos JSON'); return 2; }
          const r = decidirSolicitud({ ...cuerpo, simulacro: true }, normalizarConfig(cfg), normalizarEstado(estado));
          if (!r.ok) { e.escribir(r.error); return 2; }
          d = { decisiones: r.resultado.decisiones, diferidas: r.resultado.diferidas, estado: r.resultado.resumen };
        } else d = (await pedir(e, '/dosificador/decidir', 'POST', { ...cuerpo, simulacro: true })) as typeof d;
        salida(d, () => [`Modo ${d.estado.modo}`, ...d.decisiones.map((x) => `  ✔ ${x.tarea} → ${x.agente}/${x.equipo} ${x.lanzarEn === null ? 'ya' : `a las ${hora(x.lanzarEn)}`}  ${x.motivo}`), ...d.diferidas.map((x) => `  … ${x.tarea} ${x.hasta === null ? 'sin fecha' : `hasta ${hora(x.hasta)}`}  ${x.motivo}`)].join('\n'));
        return 0;
      }
      if (sub === 'simular') {
        const num = (k: string) => { const v = opcion(args, k); return v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v); };
        const entrada = { semanas: num('semanas'), semilla: num('semilla'), demanda: num('demanda') };
        let d: Record<string, number | null>;
        if (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http'))) {
          const ruta = rutaConfig();
          if (!ruta || !e.leer) { e.escribir('uso: kj dosificador simular --local --config <dosificador.json>'); return 2; }
          let config: unknown;
          try { config = JSON.parse(e.leer(ruta)); } catch { e.escribir(`${ruta}: no es un JSON legible`); return 2; }
          if (!config || typeof config !== 'object' || Array.isArray(config)) { e.escribir(`${ruta}: la configuración debe ser un objeto JSON`); return 2; }
          d = simularSolicitud(normalizarConfig(config), entrada) as unknown as Record<string, number | null>;
        } else d = (await pedir(e, '/dosificador/simular', 'POST', entrada)) as Record<string, number | null>;
        salida(d, () => [
          `Simulación sintética · ${d['semanas']} semanas · semilla ${d['semilla']} · ${d['agenteSemanas']} semanas de agente`,
          `  semanas por encima del margen ${d['semanasPorEncima']}  (objetivo 0) · límites alcanzados ${d['limitesAlcanzados']}`,
          `  cuota sin usar al renovar ${d['sinUsarPct']} %  (objetivo < 15 %) · uso al renovar ${d['usoFinalMedioPct']} % de media, ${d['usoFinalMaxPct']} % máximo`,
          `  espera p50 ${d['esperaP50Horas'] ?? '—'} h · p95 ${d['esperaP95Horas'] ?? '—'} h · oscilaciones de modo ${d['oscilacionesPorSemana']} por semana y agente`,
          `  tareas ${d['tareasLanzadas']} lanzadas de ${d['tareasLlegadas']} · ${d['pendientesAlFinal']} en cola al final`,
        ].join('\n'));
        return 0;
      }
      e.escribir('uso: kj dosificador estado | config [--set <json>] | decidir --entrada <fichero> | simular [--semanas N] [--semilla S] [--demanda X]   (--json en todos)');
      return 2;
    }
    case 'propuestas': {
      const d = (await pedir(e, '/laboratorio/propuestas')) as { clave: string; tarea: string; estado: string; titulo: string | null }[];
      salida(d, () => d.map((p) => `${p.tarea}  ${p.estado.padEnd(11)} ${p.titulo ?? p.clave}`).join('\n') || 'Karajan no ha propuesto nada todavía.');
      return 0;
    }
    case 'comparar': {
      const nombre = argumentosPosicionales(args.slice(1))[0] ?? '';
      const grupo = opcion(args, 'grupo');
      let d: { karajan?: Comparada; pruebas?: PruebaVista[]; skills?: Comparada[] } & Partial<Comparada>;
      if (bandera(args, 'local') || (e.localPorDefecto && !bandera(args, 'http'))) {
        const archivo = rutaRecursos();
        if (!archivo) { e.escribir('comparar local necesita --resources-db o --datos'); return 2; }
        let bib: Biblioteca;
        try { bib = abrirBibliotecaLocal(archivo); } catch (err) { e.escribir(`No se puede abrir resources.db: ${(err as Error).message}`); return 2; }
        try { d = consultarComparacion(bib, nombre, grupo ?? '', descubrirSkills, COMPONENTES.map((c) => ({ id: c.id, responsabilidad: c.responsabilidad, pruebas: c.laboratorio?.escenarios.map((x) => x.tipo) ?? [] }))) as typeof d; }
        finally { bib.cerrar(); }
      } else d = (await pedir(e, `/laboratorio/comparar?skill=${encodeURIComponent(nombre)}&grupo=${encodeURIComponent(grupo ?? '')}`)) as typeof d;
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
    case 'tutoria': {
      interface Eleg { proveedor: string; modelo: string; razonamiento: number; precio_mezcla: number; valor: number; motivo: string }
      interface Seg { clave: string; n: number; media: number; aprobados: number; aprobacionInferior: number | null; delegable: boolean }
      const el = (t: Eleg | null) => (t ? `${t.proveedor}/${t.modelo} · ${t.razonamiento} pts · ${t.precio_mezcla} USD/Mtok · valor ${t.valor}` : 'ninguno');
      if (sub === 'actualizar') {
        const r = (await pedir(e, '/laboratorio/tutores/actualizar', 'POST', {})) as { antes: Eleg | null; despues: Eleg | null; cambio: boolean; error: string | null };
        salida(r, () => (r.error ? `No se actualizó (se sigue con el catálogo anterior): ${r.error}` : `Tutor: ${el(r.despues)}${r.cambio ? `\n(antes: ${el(r.antes)})` : ' (sin cambios)'}`));
        return r.error ? 1 : 0;
      }
      if (sub === 'tutores') {
        const d = (await pedir(e, '/laboratorio/tutores')) as { tutor: Eleg | null; porProveedor: Eleg[]; obsoleto: boolean; avisos: string[]; catalogo: { actualizado: string } | null };
        salida(d, () => [`Tutor vigente: ${el(d.tutor)}`, ...d.porProveedor.map((x) => `  ${x.proveedor}: ${el(x)}\n    ${x.motivo}`), `Catálogo: ${d.catalogo?.actualizado ?? 'sin catálogo'}${d.obsoleto ? ' (OBSOLETO)' : ''}`, ...d.avisos.map((a) => `  ! ${a}`)].join('\n'));
        return 0;
      }
      if (sub === 'brechas') {
        // Para la skill skillforge-lab: dónde falla el alumno (agregados anónimos) con el alumno y el tutor de ahora.
        const b = (await pedir(e, '/laboratorio/tutoria/brechas')) as { alumno: { proveedor: string; modelo: string }; tutor: { proveedor: string; modelo: string }; brechas: { dominio: string; nivel: number; n: number; media: number; delegable: boolean }[] };
        const fichero = opcion(args, 'salida');
        if (fichero) {
          if (!e.guardar) { e.escribir('No se puede escribir ficheros desde aquí.'); return 2; }
          e.guardar(fichero, `${JSON.stringify(b, null, 2)}\n`);
          e.escribir(`Brechas guardadas en ${fichero}: ${b.brechas.filter((x) => !x.delegable).length} sin delegar de ${b.brechas.length}. Siguiente: python -m skillforge campaign from-karajan ${fichero} --output campana.json --tareas tareas.json`);
        } else salida(b, () => [`Alumno ${b.alumno.proveedor}/${b.alumno.modelo} · tutor ${b.tutor.proveedor}/${b.tutor.modelo}`, ...b.brechas.map((x) => `  ${x.dominio}·N${x.nivel}  ${x.media} %  (n=${x.n})${x.delegable ? '  delegable' : '  brecha'}`)].join('\n'));
        return 0;
      }
      const d = (await pedir(e, '/laboratorio/tutoria')) as { alumno: string | null; motivo_sin_alumno: string | null; tutor: Eleg | null; autorizado: boolean; calificacion: { nota: number | null; examenes: number; sinCalificar: number; aprobados: number; porNivel: Seg[]; porDominioNivel: Seg[]; nivelMaximoDelegable: number }; skillforge?: { laboratorio: boolean; skills: { id: string; version: number; dominios: string[] }[]; efecto: { skills: string; pares: number; deltaMedio: number; util: boolean }[] } };
      const c = d.calificacion;
      salida(d, () => [
        `Alumno: ${d.alumno ?? `no disponible (${d.motivo_sin_alumno})`} · tutor: ${el(d.tutor)}`,
        `Nota: ${c.nota === null ? 'sin exámenes todavía' : `${c.nota} %`} · ${c.examenes} exámenes (${c.aprobados} aprobados, ${c.sinCalificar} sin calificar)${d.autorizado ? '' : ' · exámenes desactivados: KARAJAN_TUTORIA_EXAMENES=1'}`,
        c.nivelMaximoDelegable ? `Se le puede delegar hasta N${c.nivelMaximoDelegable}.` : 'Aún no se le puede delegar ningún nivel (falta muestra o aprobación).',
        ...(c.porNivel.length ? ['Por nivel', barras(c.porNivel.map((x) => ({ etiqueta: x.clave, valor: x.media, nota: `n=${x.n} · aprueba ${x.aprobados}${x.delegable ? ' · delegable' : ''}` })))] : []),
        ...(c.porDominioNivel.length ? ['Por dominio y nivel', ...c.porDominioNivel.map((x) => `  ${x.clave}  ${x.media} %  (n=${x.n}, IC95 inf. ${x.aprobacionInferior})${x.delegable ? '  delegable' : ''}`)] : []),
        ...(d.skillforge?.laboratorio ? [`SkillForge: ${d.skillforge.skills.length ? d.skillforge.skills.map((s) => `${s.id}@v${s.version} (${s.dominios.join(', ')})`).join('; ') : 'sin skills forjadas activas para este alumno'}`, ...d.skillforge.efecto.map((f) => `  ${f.skills}: ${f.deltaMedio >= 0 ? '+' : ''}${f.deltaMedio} puntos en ${f.pares} tareas reales con y sin ella${f.util ? '  ÚTIL' : ''}`)] : []),
      ].join('\n'));
      return 0;
    }
    default:
      e.escribir(`${registro.ayuda()}
kj componentes | lab ls|run|informe|historial | grafica <tipo> | curador [--proponer] | comparar [<skill>|karajan] [--grupo g] | dosificador estado|config|decidir|simular | tutoria [tutores|actualizar|brechas] | propuestas | modo   (--json en todos)`);
      return cmd ? 2 : 0;
  }
}

// Solo como programa (`node kj.mjs`), no al importarlo (los tests empaquetan este módulo en el suyo).
if (process.argv[1] && /(^|[\\/])(kj|cli)\.(mjs|js|ts)$/.test(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = process.env['KARAJAN_API'] ?? `${(process.env['ATLAS_DEV_API'] ?? 'http://127.0.0.1:4100').replace(/\/$/, '')}/paquetes/karajan/api`;
  ejecutar(process.argv.slice(2), { fetch: fetch as unknown as Fetch, escribir: (s) => process.stdout.write(`${s}\n`), api, localPorDefecto: true, guardar: (ruta, contenido) => writeFileSync(ruta, contenido, 'utf8'), leer: (ruta) => readFileSync(ruta, 'utf8') })
    .then((c) => { process.exitCode = c; })
    .catch((err: Error) => { process.stderr.write(`kj: ${err.message}\n`); process.exitCode = 1; });
}
