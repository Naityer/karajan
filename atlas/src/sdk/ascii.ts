/**
 * Piezas de presentación en texto (ASCII/Unicode de caja) del SDK de Karajan. Son funciones PURAS y deterministas: reciben datos
 * y devuelven líneas, sin I/O ni dependencias, para que cada módulo las componga y para que se prueben con instantáneas.
 */
export interface FilaBarra { etiqueta: string; valor: number | null; nota?: string }
export type Formato = (x: number) => string;

const BLOQUES = '▁▂▃▄▅▆▇█';
const RAMPA = ' ░▒▓█';
export const pct: Formato = (x) => `${Math.round(x * 100)} %`;
export const num: Formato = (x) => (Number.isInteger(x) ? String(x) : Math.abs(x) < 10 ? x.toFixed(2) : x.toFixed(1));

/** Evolución de una serie en una línea; `null` deja un hueco. */
export function sparkline(valores: (number | null)[]): string {
  const v = valores.filter((x): x is number => x !== null && Number.isFinite(x));
  if (!v.length) return '';
  const min = Math.min(...v), max = Math.max(...v);
  return valores.map((x) => (x === null || !Number.isFinite(x) ? ' ' : BLOQUES[max === min ? 3 : Math.round(((x - min) / (max - min)) * 7)]!)).join('');
}

/** Barras horizontales `etiqueta ████···· valor  nota`. */
export function barras(filas: FilaBarra[], { ancho = 30, formato = (x: number) => String(x) }: { ancho?: number; formato?: Formato } = {}): string {
  if (!filas.length) return '(sin datos)';
  const max = Math.max(0, ...filas.map((f) => f.valor ?? 0)) || 1;
  const largo = Math.min(28, Math.max(...filas.map((f) => f.etiqueta.length)));
  return filas.map((f) => {
    const n = f.valor === null ? 0 : Math.round((Math.max(0, f.valor) / max) * ancho);
    return `${f.etiqueta.slice(0, largo).padEnd(largo)} ${'█'.repeat(n)}${'·'.repeat(ancho - n)} ${f.valor === null ? '—' : formato(f.valor)}${f.nota ? `  ${f.nota}` : ''}`;
  }).join('\n');
}

/** Medidor `[████······] 40 %` de `valor` sobre `max`. */
export function medidor(valor: number | null, max = 1, { ancho = 20, formato = pct }: { ancho?: number; formato?: Formato } = {}): string {
  if (valor === null || !Number.isFinite(valor)) return `[${'·'.repeat(ancho)}] —`;
  const n = Math.max(0, Math.min(ancho, Math.round((valor / (max || 1)) * ancho)));
  return `[${'█'.repeat(n)}${'·'.repeat(ancho - n)}] ${formato(max === 1 ? valor : valor / max)}`;
}

const texto = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : String(v));

/** Tabla con cabecera y columnas alineadas (números a la derecha). */
export function tabla(columnas: string[], filas: (string | number | null)[][], { maxAncho = 40 }: { maxAncho?: number } = {}): string {
  if (!filas.length) return '(sin datos)';
  const celdas = filas.map((f) => columnas.map((_, i) => texto(f[i]).slice(0, maxAncho)));
  const anchos = columnas.map((c, i) => Math.max(c.length, ...celdas.map((f) => f[i]!.length)));
  const derecha = columnas.map((_, i) => filas.every((f) => f[i] === null || typeof f[i] === 'number'));
  const pinta = (f: string[]) => f.map((c, i) => (derecha[i] ? c.padStart(anchos[i]!) : c.padEnd(anchos[i]!))).join(' │ ').trimEnd();
  return [pinta(columnas), anchos.map((a) => '─'.repeat(a)).join('─┼─'), ...celdas.map(pinta)].join('\n');
}

/** Mapa de calor con la rampa ` ░▒▓█` (cada celda 2 caracteres), normalizado por el máximo de la matriz. */
export function heatmap(filas: string[], columnas: string[], valores: (number | null)[][]): string {
  if (!filas.length || !columnas.length) return '(sin datos)';
  const max = Math.max(0, ...valores.flat().map((v) => v ?? 0)) || 1;
  const largo = Math.min(24, Math.max(...filas.map((f) => f.length)));
  const letras = columnas.map((_, i) => String.fromCharCode(65 + (i % 26)));
  const cabecera = `${' '.repeat(largo)} ${letras.map((l) => `${l} `).join('')}`.trimEnd();
  const cuerpo = filas.map((f, i) => `${f.slice(0, largo).padEnd(largo)} ${columnas.map((_, j) => { const v = valores[i]?.[j] ?? null; const g = v === null ? '·' : RAMPA[Math.max(v > 0 ? 1 : 0, Math.round((v / max) * 4))]!; return g + g; }).join('')}`.trimEnd());
  return [cabecera, ...cuerpo, `Columnas: ${columnas.map((c, i) => `${letras[i]}=${c}`).join('  ')}`, `Intensidad: ${RAMPA.trim().split('').join(' ')} (máx. ${num(max)})`].join('\n');
}

export interface NodoArbol { nombre: string; nota?: string; hijos?: NodoArbol[] }
/** Árbol con `├─ └─ │`. */
export function arbol(raiz: NodoArbol): string {
  const salida: string[] = [`${raiz.nombre}${raiz.nota ? `  ${raiz.nota}` : ''}`];
  const recorrer = (nodo: NodoArbol, prefijo: string) => {
    const hijos = nodo.hijos ?? [];
    hijos.forEach((h, i) => {
      const ultimo = i === hijos.length - 1;
      salida.push(`${prefijo}${ultimo ? '└─ ' : '├─ '}${h.nombre}${h.nota ? `  ${h.nota}` : ''}`);
      recorrer(h, prefijo + (ultimo ? '   ' : '│  '));
    });
  };
  recorrer(raiz, '');
  return salida.join('\n');
}

export interface FilaRango { etiqueta: string; p50: number | null; p90: number | null; p99?: number | null }
/** Rango de percentiles por fila: `●` p50, `◆` p90, `▲` p99 sobre una regla común. */
export function rango(filas: FilaRango[], { ancho = 40, unidad = '' }: { ancho?: number; unidad?: string } = {}): string {
  const con = filas.filter((f) => f.p50 !== null || f.p90 !== null);
  if (!con.length) return '(sin datos)';
  const max = Math.max(...con.flatMap((f) => [f.p50, f.p90, f.p99 ?? null].filter((x): x is number => x !== null))) || 1;
  const largo = Math.min(24, Math.max(...con.map((f) => f.etiqueta.length)));
  const pos = (v: number) => Math.min(ancho - 1, Math.round((v / max) * (ancho - 1)));
  const lineas = con.map((f) => {
    const regla = Array<string>(ancho).fill('─');
    for (const [v, m] of [[f.p99 ?? null, '▲'], [f.p90, '◆'], [f.p50, '●']] as [number | null, string][]) if (v !== null) regla[pos(v)] = m;
    return `${f.etiqueta.slice(0, largo).padEnd(largo)} ${regla.join('')}  p50 ${f.p50 === null ? '—' : num(f.p50)}${unidad} · p90 ${f.p90 === null ? '—' : num(f.p90)}${unidad}`;
  });
  return [...lineas, `● p50  ◆ p90  ▲ p99   (0 → ${num(max)}${unidad})`].join('\n');
}

export interface PuntoDispersion { etiqueta: string; x: number | null; y: number | null }
/** Dispersión x/y en una cuadrícula de texto; cada punto es un número que remite a la leyenda. */
export function dispersion(puntos: PuntoDispersion[], { ejeX, ejeY, ancho = 44, alto = 10 }: { ejeX: string; ejeY: string; ancho?: number; alto?: number }): string {
  const con = puntos.filter((p): p is { etiqueta: string; x: number; y: number } => p.x !== null && p.y !== null);
  if (!con.length) return '(sin datos)';
  const [minX, maxX, minY, maxY] = [Math.min(...con.map((p) => p.x)), Math.max(...con.map((p) => p.x)), Math.min(...con.map((p) => p.y)), Math.max(...con.map((p) => p.y))];
  const cuadricula = Array.from({ length: alto }, () => Array<string>(ancho).fill(' '));
  con.forEach((p, i) => {
    const cx = maxX === minX ? Math.floor(ancho / 2) : Math.round(((p.x - minX) / (maxX - minX)) * (ancho - 1));
    const cy = maxY === minY ? Math.floor(alto / 2) : Math.round(((p.y - minY) / (maxY - minY)) * (alto - 1));
    cuadricula[alto - 1 - cy]![cx] = String((i + 1) % 10);
  });
  return [`${ejeY} ↑ (${num(maxY)} arriba, ${num(minY)} abajo)`, ...cuadricula.map((f) => `│${f.join('')}`), `└${'─'.repeat(ancho)}→ ${ejeX} (${num(minX)} … ${num(maxX)})`, ...con.map((p, i) => `  ${(i + 1) % 10} ${p.etiqueta}  (${num(p.x)}, ${num(p.y)})`)].join('\n');
}

export interface CapaFlujo { nombre: string; nodos: { id: string; nombre: string; valor: number }[] }
export interface EnlaceFlujo { origen: string; destino: string; valor: number }
/** Flujo por capas (el Sankey en texto): barras por nodo de cada capa y los enlaces más fuertes. */
export function flujo(capas: CapaFlujo[], enlaces: EnlaceFlujo[], { maxEnlaces = 12 }: { maxEnlaces?: number } = {}): string {
  if (!capas.length) return '(sin datos)';
  const nombre = new Map(capas.flatMap((c) => c.nodos.map((n) => [n.id, `${c.nombre}:${n.nombre}`] as const)));
  const partes = capas.map((c) => `${c.nombre.toUpperCase()}\n${barras(c.nodos.map((n) => ({ etiqueta: `  ${n.nombre}`, valor: n.valor })), { ancho: 24 })}`);
  const top = [...enlaces].sort((a, b) => b.valor - a.valor).slice(0, maxEnlaces);
  if (top.length) partes.push(`ENLACES (los ${top.length} más fuertes)\n${top.map((l) => `  ${(nombre.get(l.origen) ?? l.origen)} ─(${l.valor})→ ${(nombre.get(l.destino) ?? l.destino)}`).join('\n')}`);
  return partes.join('\n');
}
