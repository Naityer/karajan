import type { SkillDisponible } from './skills-seleccion';
import { CATALOGO_ESPECIALISTAS } from './especialistas-catalogo';

export interface Especialista { id: string; nombre: string; ambito: string; skills: string[]; terminos: string[]; modelos: Record<string, string>; activo: boolean }
export interface ConfigEspecialistas { activo: boolean; automatico: boolean; agentes: Especialista[] }
export interface EleccionEspecialista { id: string; nombre: string; modelo: string; skills: string[]; motivo: string }
export interface ComposicionSkills { skills: string[]; procedencias: { nombre: string; origenes: ('persona' | 'sugerencia' | 'especialista')[] }[] }
export const CONFIG_ESPECIALISTAS: ConfigEspecialistas = { activo: true, automatico: true, agentes: CATALOGO_ESPECIALISTAS.map((a) => ({ ...a, skills: [...a.skills], terminos: [...a.terminos], modelos: { ...a.modelos } })) };
const normal = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const contiene = (s: string, t: string) => new RegExp(`(?<![a-z0-9])${normal(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(s);

/** Lista estable sin duplicados, con trazabilidad de cada aportación. No recorta sugerencias por tamaño de paquete. */
export function componerSkills(persona: string[], sugerencias: string[], especialista: string[] = []): ComposicionSkills {
  const vistas = new Map<string, ComposicionSkills['procedencias'][number]>();
  for (const [origen, nombres] of [['persona', persona], ['sugerencia', sugerencias], ['especialista', especialista]] as const) for (const nombre of nombres) {
    const n = nombre.trim();
    if (!n) continue;
    const k = n.toLowerCase(), fila = vistas.get(k) ?? { nombre: n, origenes: [] };
    if (!fila.origenes.includes(origen)) fila.origenes.push(origen);
    vistas.set(k, fila);
  }
  return { skills: [...vistas.values()].map((x) => x.nombre), procedencias: [...vistas.values()] };
}

/** Skills locales o recuperables. Una ficha de la biblioteca por sí sola no es una instalación. */
export function cobertura(a: Especialista, catalogo: SkillDisponible[]) {
  const disponibles = new Map(catalogo.filter((s) => s.instaladaEn.length || s.enAlmacen.length).map((s) => [s.name.toLowerCase(), s.name]));
  const skills = a.skills.map((n) => disponibles.get(n.toLowerCase())).filter((n): n is string => !!n);
  const faltan = a.skills.filter((n) => !disponibles.has(n.toLowerCase()));
  return { viable: a.activo && skills.length >= 2 && !faltan.length, skills, faltan };
}

/** Sin coincidencia, empate o paquete incompleto se conserva el flujo original. Un proveedor fijado nunca se cambia aquí. */
export function elegirEspecialista(prompt: string, proveedor: string, catalogo: SkillDisponible[], config: ConfigEspecialistas, solicitado?: string | null): EleccionEspecialista | null {
  if (!config.activo || solicitado === 'ninguno' || (!solicitado && !config.automatico)) return null;
  const texto = normal(prompt);
  const candidatos = config.agentes.filter((a) => a.activo && !!a.modelos[proveedor] && (!solicitado || a.id === solicitado))
    .map((a) => ({ a, puntos: solicitado ? 100 : a.terminos.filter((t) => contiene(texto, t)).length }))
    .filter((x) => x.puntos > 0)
    .map((x) => ({ ...x, c: cobertura(x.a, catalogo) }))
    .filter((x) => x.c.viable).sort((a, b) => b.puntos - a.puntos || a.a.id.localeCompare(b.a.id));
  const primera = candidatos[0];
  if (!primera || (!solicitado && candidatos[1]?.puntos === primera.puntos)) return null;
  return { id: primera.a.id, nombre: primera.a.nombre, modelo: primera.a.modelos[proveedor]!, skills: primera.c.skills, motivo: solicitado ? 'especialista solicitado' : `ámbito ${primera.a.nombre}` };
}

/** Snapshot acotado. Un fallo de refresco no prolonga una disponibilidad obsoleta. */
export function inventarioConCache(leer: () => SkillDisponible[], ttlMs = 15_000, ahora = Date.now) {
  let cache: { hasta: number; skills: SkillDisponible[] } | null = null;
  return { leer: () => { if (!cache || ahora() >= cache.hasta) { cache = null; const skills = leer(); cache = { hasta: ahora() + ttlMs, skills }; } return cache.skills; }, invalidar: () => { cache = null; } };
}

/** La preparación es opcional: un error invalida el paquete entero, sin desinstalar ni ejecutar nada. */
export function prepararEspecialista(e: EleccionEspecialista, asegurar: (nombre: string) => { disponible: boolean }): boolean {
  try { return e.skills.every((nombre) => asegurar(nombre).disponible); } catch { return false; }
}
