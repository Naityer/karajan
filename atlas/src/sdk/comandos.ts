import type { Panel } from './panel';

/**
 * Patrón Command: cada acción de Karajan (de un módulo o de un componente) es un objeto con su ruta (`['estadisticas', 'resumen']`),
 * su ayuda y un `ejecutar` que devuelve un `Panel` — nunca imprime. El registro resuelve la línea de comandos contra esas rutas,
 * de modo que añadir un módulo o un componente no toca el despachador de `cli.ts`.
 */
export interface Contexto {
  /** Llama al servidor de Karajan (rutas del paquete). Lanza si la respuesta no es correcta. */
  pedir(ruta: string, metodo?: string, cuerpo?: unknown): Promise<unknown>;
  opcion(nombre: string): string | null;
  bandera(nombre: string): boolean;
}

/** Argumentos posicionales: no confundir el valor de una opción con el prompt o id. */
export function argumentosPosicionales(args: string[]): string[] {
  const conValor = new Set(['--perfil', '--especialista', '--layout', '--datos', '--datos-atlas', '--tasks-db', '--resources-db', '--config', '--estado', '--lab-db', '--dias', '--limite', '--tarea', '--grupo']);
  const salida: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (conValor.has(args[i]!)) { i++; continue; }
    if (!args[i]!.startsWith('--')) salida.push(args[i]!);
  }
  return salida;
}

export interface Comando {
  /** Palabras que lo identifican, p. ej. `['estadisticas', 'agentes']`. Un `*` en una posición admite cualquier palabra. */
  ruta: string[];
  resumen: string;
  uso?: string;
  /** `args` son los argumentos tras las palabras de la ruta; `ruta` las palabras reales que coincidieron (con el `*` ya resuelto). */
  ejecutar(ctx: Contexto, args: string[], ruta: string[]): Promise<Panel>;
}

export class RegistroComandos {
  private readonly comandos: Comando[] = [];

  registrar(...nuevos: Comando[]): this {
    for (const c of nuevos) {
      if (this.comandos.some((x) => x.ruta.join(' ') === c.ruta.join(' '))) throw new Error(`comando duplicado: ${c.ruta.join(' ')}`);
      this.comandos.push(c);
    }
    return this;
  }

  /** El comando cuyo prefijo de ruta coincide (el más específico gana) y el resto de argumentos (sin las palabras de la ruta). */
  resolver(args: string[]): { comando: Comando; resto: string[]; ruta: string[] } | null {
    const palabras = args.filter((a) => !a.startsWith('--'));
    let mejor: Comando | null = null;
    for (const c of this.comandos) {
      if (c.ruta.length > palabras.length) continue;
      if (c.ruta.every((p, i) => p === '*' || p === palabras[i]) && (!mejor || c.ruta.length > mejor.ruta.length)) mejor = c;
    }
    return mejor ? { comando: mejor, resto: args.slice(mejor.ruta.length), ruta: palabras.slice(0, mejor.ruta.length) } : null;
  }

  /** Los comandos agrupados por su primera palabra, para la ayuda. */
  ayuda(): string {
    const grupos = new Map<string, Comando[]>();
    for (const c of this.comandos) grupos.set(c.ruta[0]!, [...(grupos.get(c.ruta[0]!) ?? []), c]);
    return [...grupos].map(([g, cs]) => [`${g}`, ...cs.map((c) => `  kj ${c.uso ?? c.ruta.join(' ')}  — ${c.resumen}`)].join('\n')).join('\n');
  }

  todos(): readonly Comando[] { return this.comandos; }
}
