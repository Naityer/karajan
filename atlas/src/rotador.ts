import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Rotador de skills bajo demanda. Las skills instaladas cuestan contexto a cada agente, así que solo se dejan las que se usan;
 * el resto espera en un almacén local (`~/.karajan/skills-almacen/<destino>/<skill>`): retirar es MOVER la carpeta allí y
 * reponerla es moverla de vuelta, sin red y al instante. Nada se borra.
 *
 *   núcleo       usada en los últimos 14 días            → siempre instalada
 *   frecuente    usada en los últimos 45 días            → se mantiene; pasado ese plazo sin uso, al almacén
 *   instantánea  repuesta para una delegación concreta   → se instala justo antes de ejecutar; tras 3 días sin uso, al almacén
 *
 * El uso sale de los transcripts de Claude Code (`skills-uso.json` de Atlas dev), de las ejecuciones de Karajan y de lo que el
 * propio rotador repone. Las protegidas (las del router, las de latex-template y las que se añadan) nunca se retiran.
 */
export type Destino = 'claude' | 'codex' | 'agents';
export type NivelSkill = 'nucleo' | 'frecuente' | 'instantanea' | 'inactiva';
export interface ConfigRotador { nucleoDias: number; frecuenteDias: number; instantaneaDias: number; protegidas: string[] }
export interface EstadoRotador { config: ConfigRotador; repuestas: Record<string, string>; usos: Record<string, string> }
export interface FilaRotador { skill: string; nivel: NivelSkill; ultimoUso: string | null; instaladaEn: Destino[]; enAlmacen: Destino[]; protegida: boolean }
export interface PlanRotacion { retirar: { skill: string; destino: Destino; motivo: string }[]; reponer: { skill: string; destino: Destino; motivo: string }[] }

const DIA = 86_400_000;
/** Usos por skill y día (`AAAA-MM-DD`). */
export type HistorialUso = Record<string, Record<string, number>>;
/** Nivel de una skill según los días sin uso y, si se repuso, los días desde la reposición. */
export function nivelPorDias(diasSinUso: number, diasDesdeReposicion: number | null, c: Pick<ConfigRotador, 'nucleoDias' | 'frecuenteDias' | 'instantaneaDias'>): NivelSkill {
  if (diasSinUso <= c.nucleoDias) return 'nucleo';
  if (diasSinUso <= c.frecuenteDias) return 'frecuente';
  if (diasDesdeReposicion !== null && diasDesdeReposicion <= c.instantaneaDias) return 'instantanea';
  return 'inactiva';
}
export const PROTEGIDAS_BASE = [
  'atlas', 'atlas-scan', 'atlas-task', 'ateneo', 'ateneo-destilar', 'ateneo-fuentes', 'karajan', 'task-router',
  'repo-analyzer', 'frontend-builder', 'backend-builder', 'security-review', 'cti-analyst', 'ponytail', 'impeccable', 'skill-creator',
];
const CONFIG_BASE: ConfigRotador = { nucleoDias: 14, frecuenteDias: 45, instantaneaDias: 3, protegidas: PROTEGIDAS_BASE };
/** Carpetas que no son skills (o están desactivadas a mano): no se tocan. */
const ignorar = (n: string) => n.startsWith('.') || n.startsWith('_') || n.endsWith('.disabled') || n === 'synced';
export const destinoDe = (proveedor: string): Destino | null => (proveedor === 'claude-cli' ? 'claude' : proveedor === 'codex' ? 'codex' : null);

export interface OpcionesRotador {
  casa?: string;
  /** Fichero de estado (`<datos>/rotador.json`). */
  estado: string;
  /** Uso de skills de Atlas dev (por defecto `<ATLAS_DEV_DATA>/skills-uso.json`). */
  usoAtlas?: string;
  /** Últimos usos que vienen de las ejecuciones de Karajan. */
  usosKarajan?: () => Record<string, string>;
  /** Historia de esas mismas ejecuciones (una entrada por skill y ejecución), para reproducir el uso día a día. */
  historiaKarajan?: () => { skill: string; cuando: string }[];
  ahora?: () => number;
}

export class Rotador {
  private readonly casa: string;
  private readonly ahora: () => number;
  constructor(private readonly op: OpcionesRotador) {
    this.casa = op.casa ?? homedir();
    this.ahora = op.ahora ?? Date.now;
  }

  raiz(d: Destino) { return join(this.casa, d === 'claude' ? '.claude' : d === 'codex' ? '.codex' : '.agents', 'skills'); }
  almacen(d: Destino) { return join(this.casa, '.karajan', 'skills-almacen', d); }

  leerEstado(): EstadoRotador {
    try {
      const e = JSON.parse(readFileSync(this.op.estado, 'utf8')) as Partial<EstadoRotador>;
      return { config: { ...CONFIG_BASE, ...(e.config ?? {}), protegidas: [...new Set([...PROTEGIDAS_BASE, ...(e.config?.protegidas ?? [])])] }, repuestas: e.repuestas ?? {}, usos: e.usos ?? {} };
    } catch { return { config: { ...CONFIG_BASE }, repuestas: {}, usos: {} }; }
  }

  private guardarEstado(e: EstadoRotador) {
    mkdirSync(dirname(this.op.estado), { recursive: true });
    writeFileSync(`${this.op.estado}.tmp`, `${JSON.stringify(e, null, 2)}\n`, 'utf8');
    renameSync(`${this.op.estado}.tmp`, this.op.estado);
  }

  private carpetas(dir: string): string[] {
    try { return readdirSync(dir).filter((n) => !ignorar(n) && statSync(join(dir, n)).isDirectory() && existsSync(join(dir, n, 'SKILL.md'))); } catch { return []; }
  }

  /** Último uso de cada skill (el más reciente de las tres fuentes). El nombre de un plugin («x:skill») cuenta como «skill». */
  ultimosUsos(): Record<string, string> {
    const r: Record<string, string> = {};
    const anotar = (nombre: string, cuando: string | null | undefined) => {
      if (!cuando) return;
      const n = nombre.includes(':') ? nombre.slice(nombre.lastIndexOf(':') + 1) : nombre;
      if (!r[n] || cuando > r[n]!) r[n] = cuando;
    };
    const ruta = this.op.usoAtlas ?? join(process.env['ATLAS_DEV_DATA'] ?? join(this.casa, '.atlas-dev'), 'skills-uso.json');
    try {
      const d = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, { skills?: Record<string, { ultima?: string | null }> }>;
      for (const f of Object.values(d)) for (const [n, u] of Object.entries(f.skills ?? {})) anotar(n, u.ultima);
    } catch { /* sin datos de Atlas dev */ }
    for (const [n, c] of Object.entries(this.op.usosKarajan?.() ?? {})) anotar(n, c);
    for (const [n, c] of Object.entries(this.leerEstado().usos)) anotar(n, c);
    return r;
  }

  nivel(skill: string, ultimo: string | null, e: EstadoRotador): NivelSkill {
    const repuesta = e.repuestas[skill];
    return nivelPorDias(ultimo ? (this.ahora() - Date.parse(ultimo)) / DIA : Infinity, repuesta ? (this.ahora() - Date.parse(repuesta)) / DIA : null, e.config);
  }

  /** Uso de cada skill día a día (`{ skill: { 'AAAA-MM-DD': usos } }`): `dias` de Atlas dev, ejecuciones de Karajan y último uso registrado a mano. */
  historial(): HistorialUso {
    const h: HistorialUso = {};
    const anotar = (nombre: string, dia: string | null | undefined, n = 1) => {
      if (!dia || !/^\d{4}-\d{2}-\d{2}/.test(dia)) return;
      const s = nombre.includes(':') ? nombre.slice(nombre.lastIndexOf(':') + 1) : nombre;
      const fila = (h[s] ??= {});
      fila[dia.slice(0, 10)] = (fila[dia.slice(0, 10)] ?? 0) + n;
    };
    const ruta = this.op.usoAtlas ?? join(process.env['ATLAS_DEV_DATA'] ?? join(this.casa, '.atlas-dev'), 'skills-uso.json');
    try {
      const d = JSON.parse(readFileSync(ruta, 'utf8')) as Record<string, { skills?: Record<string, { dias?: Record<string, number> }> }>;
      for (const f of Object.values(d)) for (const [n, u] of Object.entries(f.skills ?? {})) for (const [dia, c] of Object.entries(u.dias ?? {})) anotar(n, dia, c);
    } catch { /* sin datos de Atlas dev */ }
    for (const x of this.op.historiaKarajan?.() ?? []) anotar(x.skill, x.cuando);
    for (const [n, c] of Object.entries(this.leerEstado().usos)) anotar(n, c);
    return h;
  }

  /** Todas las skills que hay (instaladas o en el almacén) con su nivel. */
  inventario(): FilaRotador[] {
    const e = this.leerEstado();
    const usos = this.ultimosUsos();
    const destinos: Destino[] = ['claude', 'codex', 'agents'];
    const instaladas = new Map(destinos.map((d) => [d, new Set(this.carpetas(this.raiz(d)))]));
    const guardadas = new Map(destinos.map((d) => [d, new Set(this.carpetas(this.almacen(d)))]));
    const nombres = new Set(destinos.flatMap((d) => [...instaladas.get(d)!, ...guardadas.get(d)!]));
    return [...nombres].sort((a, b) => a.localeCompare(b)).map((skill) => ({
      skill, nivel: this.nivel(skill, usos[skill] ?? null, e), ultimoUso: usos[skill] ?? null,
      instaladaEn: destinos.filter((d) => instaladas.get(d)!.has(skill)), enAlmacen: destinos.filter((d) => guardadas.get(d)!.has(skill)),
      protegida: e.config.protegidas.includes(skill),
    }));
  }

  /** Qué se retiraría (inactivas no protegidas) y qué se repondría (las del almacén que se vuelven a usar). */
  plan(): PlanRotacion {
    const plan: PlanRotacion = { retirar: [], reponer: [] };
    for (const f of this.inventario()) {
      if (f.nivel === 'inactiva' && !f.protegida) {
        for (const d of f.instaladaEn) plan.retirar.push({ skill: f.skill, destino: d, motivo: f.ultimoUso ? `sin uso desde ${f.ultimoUso.slice(0, 10)}` : 'nunca usada' });
      } else if (f.nivel === 'nucleo' || f.nivel === 'frecuente') {
        for (const d of f.enAlmacen) if (!f.instaladaEn.includes(d)) plan.reponer.push({ skill: f.skill, destino: d, motivo: `usada el ${f.ultimoUso?.slice(0, 10)}` });
      }
    }
    return plan;
  }

  private mover(desde: string, hasta: string) {
    mkdirSync(dirname(hasta), { recursive: true });
    if (existsSync(hasta)) rmSync(hasta, { recursive: true, force: true });
    try { renameSync(desde, hasta); } catch { cpSync(desde, hasta, { recursive: true }); rmSync(desde, { recursive: true, force: true }); }
  }

  /** Aplica un plan (o el actual). Devuelve lo hecho. */
  aplicar(plan = this.plan()): PlanRotacion {
    for (const r of plan.retirar) this.mover(join(this.raiz(r.destino), r.skill), join(this.almacen(r.destino), r.skill));
    for (const r of plan.reponer) this.mover(join(this.almacen(r.destino), r.skill), join(this.raiz(r.destino), r.skill));
    const e = this.leerEstado();
    for (const r of plan.retirar) delete e.repuestas[r.skill];
    this.guardarEstado(e);
    return plan;
  }

  /**
   * Antes de delegar: deja instalada la skill para el agente que va a ejecutar. Si está en el almacén se repone al momento (queda
   * como «instantánea»). Preparar una skill no demuestra uso; solo una traza confirmada lo registra.
   */
  asegurar(skill: string, destino: Destino): { disponible: boolean; repuesta: boolean; motivo: string } {
    const e = this.leerEstado();
    const ahora = new Date(this.ahora()).toISOString();
    const instalada = existsSync(join(this.raiz(destino), skill, 'SKILL.md'));
    let repuesta = false;
    if (!instalada) {
      const origen = [destino, ...(['claude', 'codex', 'agents'] as Destino[]).filter((d) => d !== destino)].map((d) => join(this.almacen(d), skill)).find((p) => existsSync(join(p, 'SKILL.md')))
        ?? (['claude', 'codex', 'agents'] as Destino[]).filter((d) => d !== destino).map((d) => join(this.raiz(d), skill)).find((p) => existsSync(join(p, 'SKILL.md')));
      if (origen) {
        mkdirSync(this.raiz(destino), { recursive: true });
        if (origen.includes(join('.karajan', 'skills-almacen'))) this.mover(origen, join(this.raiz(destino), skill));
        else cpSync(origen, join(this.raiz(destino), skill), { recursive: true });
        e.repuestas[skill] = ahora;
        repuesta = true;
      }
    }
    this.guardarEstado(e);
    const disponible = instalada || repuesta;
    return { disponible, repuesta, motivo: instalada ? 'ya instalada' : repuesta ? 'repuesta desde el almacén' : 'no está ni instalada ni en el almacén' };
  }

  registrarUso(skill: string) {
    const e = this.leerEstado();
    e.usos[skill] = new Date(this.ahora()).toISOString();
    this.guardarEstado(e);
  }
}

export interface ResultadoSimulacion { dias: number; usos: number; fallos: number; instaladasMedia: number; movimientos: number }
const diaNum = (fecha: string) => Math.floor(Date.parse(`${fecha.slice(0, 10)}T00:00:00Z`) / DIA);

/**
 * Simulación pura de la rotación sobre un historial: cada mañana se aplica el plan con los usos de días anteriores y luego se usan
 * las skills del día; una que esté en el almacén es un fallo (reposición evitable). Empieza con todo instalado y no puntúa los
 * primeros `calentamiento` días, para que el estado inicial no pese. Mismas reglas que `Rotador` (`nivelPorDias`); las protegidas no entran.
 */
export function simularRotacion(historial: HistorialUso, config: Pick<ConfigRotador, 'nucleoDias' | 'frecuenteDias' | 'instantaneaDias'>, calentamiento: number): ResultadoSimulacion {
  const skills = Object.keys(historial);
  const dias = skills.flatMap((s) => Object.keys(historial[s]!).map(diaNum));
  const r: ResultadoSimulacion = { dias: 0, usos: 0, fallos: 0, instaladasMedia: 0, movimientos: 0 };
  if (!dias.length) return r;
  const ini = Math.min(...dias), fin = Math.max(...dias);
  const usosDe = new Map(skills.map((s) => [s, new Set(Object.keys(historial[s]!).map(diaNum))]));
  const instalada = new Set(skills), ultimo = new Map<string, number>(), repuesta = new Map<string, number>();
  let suma = 0;
  for (let d = ini; d <= fin; d++) {
    const puntua = d - ini >= calentamiento;
    for (const s of skills) {
      const n = nivelPorDias(ultimo.has(s) ? d - ultimo.get(s)! : Infinity, repuesta.has(s) ? d - repuesta.get(s)! : null, config);
      if (n === 'inactiva' && instalada.has(s)) { instalada.delete(s); if (puntua) r.movimientos++; }
      else if ((n === 'nucleo' || n === 'frecuente') && !instalada.has(s)) { instalada.add(s); if (puntua) r.movimientos++; }
    }
    for (const s of skills) {
      if (!usosDe.get(s)!.has(d)) continue;
      if (puntua) r.usos++;
      if (!instalada.has(s)) { instalada.add(s); repuesta.set(s, d); if (puntua) { r.fallos++; r.movimientos++; } }
      ultimo.set(s, d);
    }
    if (puntua) { r.dias++; suma += instalada.size; }
  }
  r.instaladasMedia = r.dias ? Math.round((suma / r.dias) * 100) / 100 : 0;
  return r;
}
