/**
 * Lógica pura del panel «¿Son correctas estas skills?» (sin React ni red, para poder probarla): combinar la propuesta con la corrección,
 * decidir si la respuesta es «sí» o «no», armar el cuerpo de `POST /laboratorio/calibracion`, el debounce del buscador y el formato de las tarjetas.
 */

/** Una tarjeta tal como la devuelve `GET /laboratorio/sugerencias-skills` (sugeridas con `puntos`; encontradas sin ellos). */
export interface TarjetaSkill {
  nombre: string; puntos: number | null; descripcion: string; estrellas: number | null; heredadas: boolean;
  repo_url: string | null; grupo: string | null; instalada: boolean; almacen: boolean; instalable?: boolean;
}
export interface Sugerencias { sugeridas: TarjetaSkill[]; encontradas: TarjetaSkill[]; biblioteca: boolean }
export type Respuesta = 'si' | 'no' | 'sin_revisar';
export interface CuerpoCalibracion { tarea: string; componente: 'selector'; propuesta: string[]; respuesta: Respuesta; correccion: string[] }

/** Nombres sin vacíos ni repetidos, en el orden de entrada. */
export const unicas = (nombres: readonly string[]): string[] => [...new Set(nombres.map((n) => n.trim()).filter(Boolean))];

/** Añade la skill si no estaba; la quita si estaba. No muta la lista de entrada. */
export const alternar = (elegidas: readonly string[], nombre: string): string[] => (elegidas.includes(nombre) ? elegidas.filter((n) => n !== nombre) : [...elegidas, nombre]);

/** Las skills finales: la propuesta sin las quitadas, más las añadidas (primero la propuesta que sobrevive). */
export const combinar = (propuesta: readonly string[], anadidas: readonly string[], quitadas: readonly string[]): string[] =>
  unicas([...propuesta.filter((n) => !quitadas.includes(n)), ...anadidas.filter((n) => !quitadas.includes(n))]);

/** Mismo conjunto de skills, sin importar el orden. */
export const mismoConjunto = (a: readonly string[], b: readonly string[]): boolean => {
  const x = new Set(a), y = new Set(b);
  return x.size === y.size && [...x].every((n) => y.has(n));
};

/** «sí» si lo elegido es lo propuesto; «no» en cuanto cambia algo. */
export const respuestaDe = (propuesta: readonly string[], finales: readonly string[]): Respuesta => (mismoConjunto(propuesta, finales) ? 'si' : 'no');

/** El cuerpo de la calibración. Con «sí» no hay corrección (el servidor toma la propuesta como verdad). */
export function cuerpoCalibracion(tarea: string, propuesta: readonly string[], respuesta: Respuesta, finales: readonly string[]): CuerpoCalibracion {
  return { tarea, componente: 'selector', propuesta: [...propuesta], respuesta, correccion: respuesta === 'no' ? [...finales] : [] };
}

/** Solo se enlazan repositorios de GitHub por https (el enlace sale de la biblioteca, que es un dato ajeno). */
export function urlGithub(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname === 'www.github.com') ? u.href : null;
  } catch { return null; }
}

/** «1,2 mil», «850», «2,3 M». */
export function formatearEstrellas(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const f = (v: number) => v.toLocaleString('es-ES', { maximumFractionDigits: 1 });
  return n >= 1_000_000 ? `${f(n / 1_000_000)} M` : n >= 1000 ? `${f(n / 1000)} mil` : f(n);
}

/** Dónde está la skill: instalada, en el almacén (se activa al usarla) o solo en la biblioteca (instalable). */
export const estadoDe = (t: TarjetaSkill): 'instalada' | 'almacen' | 'instalable' | 'desconocida' =>
  t.instalada ? 'instalada' : t.almacen ? 'almacen' : t.instalable ? 'instalable' : 'desconocida';

/** Las encontradas sin las que ya salen como sugeridas ni repetidas entre sí, para no pintar dos tarjetas de lo mismo. */
export const sinRepetir = (encontradas: readonly TarjetaSkill[], sugeridas: readonly TarjetaSkill[]): TarjetaSkill[] => {
  const vistas = new Set(sugeridas.map((t) => t.nombre));
  return encontradas.filter((t) => !vistas.has(t.nombre) && vistas.add(t.nombre));
};

/** El prompt que se manda a la consulta de sugerencias (va en la URL: se recorta). */
export const promptParaConsulta = (prompt: string, max = 1500): string => prompt.slice(0, max);

/** Debounce con cancelación: la función se llama una sola vez, `ms` después de la última llamada. */
export function conRetardo<A extends unknown[]>(fn: (...a: A) => void, ms: number, reloj: { set: typeof setTimeout; clear: typeof clearTimeout } = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }): ((...a: A) => void) & { cancelar(): void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  const f = (...a: A) => { if (t) reloj.clear(t); t = reloj.set(() => { t = null; fn(...a); }, ms); };
  f.cancelar = () => { if (t) reloj.clear(t); t = null; };
  return f;
}
