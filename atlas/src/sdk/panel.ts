import { arbol, barras, dispersion, flujo, heatmap, medidor, num, pct, rango, sparkline, tabla, type CapaFlujo, type EnlaceFlujo, type FilaBarra, type FilaRango, type NodoArbol, type PuntoDispersion } from './ascii';

/**
 * `Panel`: lo que devuelve cada comando del SDK. Es DATOS serializables (no texto): el mismo panel se pinta en ASCII para la
 * terminal (`renderAscii`) o se entrega tal cual con `--json` (`renderJson`) para que la interfaz web lo dibuje a su manera.
 * Patrón: Strategy (los renderizadores son intercambiables) sobre un modelo de presentación común.
 */
export type Unidad = 'num' | 'pct' | 'seg' | 'usd' | 'ms';
export type Bloque =
  | { tipo: 'texto'; titulo?: string; lineas: string[] }
  | { tipo: 'barras'; titulo?: string; filas: FilaBarra[]; unidad?: Unidad }
  | { tipo: 'tabla'; titulo?: string; columnas: string[]; filas: (string | number | null)[][] }
  | { tipo: 'serie'; titulo?: string; puntos: (number | null)[]; etiquetas?: string[] }
  | { tipo: 'heatmap'; titulo?: string; filas: string[]; columnas: string[]; valores: (number | null)[][] }
  | { tipo: 'arbol'; titulo?: string; raiz: NodoArbol }
  | { tipo: 'medidor'; titulo?: string; valor: number | null; max?: number; unidad?: Unidad }
  | { tipo: 'rango'; titulo?: string; filas: FilaRango[]; unidad?: string }
  | { tipo: 'dispersion'; titulo?: string; puntos: PuntoDispersion[]; ejeX: string; ejeY: string }
  | { tipo: 'flujo'; titulo?: string; capas: CapaFlujo[]; enlaces: EnlaceFlujo[] };

export interface Panel {
  /** Módulo o componente que lo produce (`estadisticas`, `delegador`…). */
  origen: string;
  titulo: string;
  subtitulo?: string;
  bloques: Bloque[];
  /** Datos de origen sin presentar (los usa `--json`). */
  datos?: unknown;
}

const FORMATOS: Record<Unidad, (x: number) => string> = { num, pct, seg: (x) => `${num(x)} s`, usd: (x) => `${x.toFixed(2)} $`, ms: (x) => `${Math.round(x)} ms` };

function pintarBloque(b: Bloque): string {
  switch (b.tipo) {
    case 'texto': return b.lineas.join('\n');
    case 'barras': return barras(b.filas, { formato: FORMATOS[b.unidad ?? 'num'] });
    case 'tabla': return tabla(b.columnas, b.filas);
    case 'serie': return b.puntos.length ? `${sparkline(b.puntos)}${b.etiquetas?.length ? `  (${b.etiquetas[0]} → ${b.etiquetas[b.etiquetas.length - 1]})` : ''}` : '(sin datos)';
    case 'heatmap': return heatmap(b.filas, b.columnas, b.valores);
    case 'arbol': return arbol(b.raiz);
    case 'medidor': return medidor(b.valor, b.max ?? 1, { formato: FORMATOS[b.unidad ?? 'pct'] });
    case 'rango': return rango(b.filas, { unidad: b.unidad });
    case 'dispersion': return dispersion(b.puntos, { ejeX: b.ejeX, ejeY: b.ejeY });
    case 'flujo': return flujo(b.capas, b.enlaces);
  }
}

/** Panel → texto para la terminal. */
export function renderAscii(p: Panel): string {
  const cabecera = `${p.titulo}${p.subtitulo ? `  ·  ${p.subtitulo}` : ''}`;
  const partes = p.bloques.map((b) => (b.titulo ? `${b.titulo}\n${'─'.repeat(Math.min(60, b.titulo.length))}\n${pintarBloque(b)}` : pintarBloque(b)));
  return [cabecera, '═'.repeat(Math.min(72, Math.max(cabecera.length, 8))), ...partes.flatMap((x) => [x, ''])].join('\n').trimEnd();
}

/** Panel → JSON (el contrato que consumirá la interfaz): `datos` si el módulo los aportó, y siempre los bloques. */
export function renderJson(p: Panel): string {
  return JSON.stringify({ origen: p.origen, titulo: p.titulo, subtitulo: p.subtitulo ?? null, datos: p.datos ?? null, bloques: p.bloques }, null, 2);
}
