import type { Ficha } from './tipos';

/**
 * «Cómo funciona»: entradas → pasos → salidas, dibujado en SVG a partir de la ficha del componente. Se organiza en vertical
 * (cabe en el cajón de detalle sin encoger el texto) y el texto se parte a mano porque SVG no hace saltos de línea.
 * Es SVG puro con clases, así que se puede reutilizar para exportar (`kj grafica --svg`) y sigue los temas por tokens.
 */
const W = 380, PAD = 10, GAP = 10, LINEA = 15, FUENTE = 12.2, ANCHO_CAR = 6.25;

function partir(texto: string, ancho: number): string[] {
  const max = Math.max(8, Math.floor(ancho / ANCHO_CAR));
  const lineas: string[] = [];
  let actual = '';
  for (const palabra of texto.split(/\s+/)) {
    if (!actual) actual = palabra;
    else if ((actual + ' ' + palabra).length <= max) actual += ' ' + palabra;
    else { lineas.push(actual); actual = palabra; }
  }
  if (actual) lineas.push(actual);
  return lineas.length ? lineas : [''];
}

interface Nodo { x: number; y: number; w: number; h: number; lineas: string[]; n?: number }

/** Reparte textos en filas de una o dos columnas; devuelve los nodos y la altura que ocupan. */
function filas(textos: string[], y0: number, margenIzq = 0): { nodos: Nodo[]; alto: number } {
  const cols = textos.length === 1 ? 1 : 2;
  const ancho = (W - 2 * PAD - margenIzq - GAP * (cols - 1)) / cols;
  const nodos: Nodo[] = [];
  let y = y0;
  for (let i = 0; i < textos.length; i += cols) {
    const fila = textos.slice(i, i + cols).map((t) => partir(t, ancho - 18));
    const alto = Math.max(...fila.map((l) => l.length)) * LINEA + 14;
    fila.forEach((lineas, j) => nodos.push({ x: PAD + margenIzq + j * (ancho + GAP), y, w: ancho, h: alto, lineas }));
    y += alto + GAP;
  }
  return { nodos, alto: y - y0 - GAP };
}

function Texto({ nodo, desde = 9 }: { nodo: Nodo; desde?: number }) {
  return (
    <text x={nodo.x + desde} y={nodo.y + 7 + LINEA * 0.8} fontSize={FUENTE}>
      {nodo.lineas.map((l, i) => <tspan key={i} x={nodo.x + desde} dy={i === 0 ? 0 : LINEA}>{l}</tspan>)}
    </text>
  );
}

function Flecha({ x, y, largo = 18 }: { x: number; y: number; largo?: number }) {
  return <g className="kj-d-flecha"><line x1={x} y1={y} x2={x} y2={y + largo - 5} /><path d={`M${x - 4} ${y + largo - 7} L${x} ${y + largo} L${x + 4} ${y + largo - 7} z`} /></g>;
}

export function DiagramaFuncionamiento({ ficha, nombre }: { ficha: Ficha; nombre: string }) {
  const { entradas, pasos, salidas } = ficha.como_funciona;
  let y = PAD;
  const elementos: React.ReactNode[] = [];
  const rotulo = (texto: string, yy: number) => <text key={`r-${texto}`} x={PAD} y={yy + 9} className="kj-d-rotulo">{texto}</text>;

  // Entradas
  y += 0;
  elementos.push(rotulo('ENTRADAS', y));
  y += 16;
  const ent = filas(entradas.length ? entradas : ['—'], y);
  ent.nodos.forEach((n, i) => elementos.push(<g key={`e${i}`} className="kj-d-entrada"><rect x={n.x} y={n.y} width={n.w} height={n.h} rx={7} /><Texto nodo={n} /></g>));
  y += ent.alto;
  elementos.push(<Flecha key="f1" x={W / 2} y={y + 3} />);
  y += 26;

  // Pasos (cadena vertical, numerados)
  elementos.push(rotulo(`PROCESO · ${nombre.toUpperCase()}`, y));
  y += 16;
  pasos.forEach((p, i) => {
    const lineas = partir(p, W - 2 * PAD - 44);
    const h = lineas.length * LINEA + 16;
    const n: Nodo = { x: PAD, y, w: W - 2 * PAD, h, lineas };
    elementos.push(
      <g key={`p${i}`} className="kj-d-paso">
        <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={7} />
        <circle cx={n.x + 17} cy={n.y + h / 2} r={9.5} />
        <text x={n.x + 17} y={n.y + h / 2 + 4} textAnchor="middle" className="kj-d-num" fontSize={11}>{i + 1}</text>
        <text x={n.x + 35} y={n.y + (h - lineas.length * LINEA) / 2 + LINEA * 0.8} fontSize={FUENTE}>{lineas.map((l, k) => <tspan key={k} x={n.x + 35} dy={k === 0 ? 0 : LINEA}>{l}</tspan>)}</text>
      </g>,
    );
    y += h;
    if (i < pasos.length - 1) { elementos.push(<Flecha key={`pf${i}`} x={W / 2} y={y} largo={12} />); y += 12; }
  });
  elementos.push(<Flecha key="f2" x={W / 2} y={y + 3} />);
  y += 26;

  // Salidas
  elementos.push(rotulo('SALIDAS', y));
  y += 16;
  const sal = filas(salidas.length ? salidas : ['—'], y);
  sal.nodos.forEach((n, i) => elementos.push(<g key={`s${i}`} className="kj-d-salida"><rect x={n.x} y={n.y} width={n.w} height={n.h} rx={7} /><Texto nodo={n} /></g>));
  y += sal.alto + PAD;

  return (
    <svg className="kj-diagrama" viewBox={`0 0 ${W} ${y}`} role="img" aria-label={`Cómo funciona ${nombre}: entradas ${entradas.join(', ')}; pasos ${pasos.map((p, i) => `${i + 1}. ${p}`).join('; ')}; salidas ${salidas.join(', ')}`} style={{ maxWidth: W * 1.45 }}>
      <title>Cómo funciona {nombre}</title>
      {elementos}
    </svg>
  );
}
