/**
 * Redondeo y formato como los de Python (`round(x, n)` y `f"{x:.nf}"`): sobre el valor EXACTO del número en binario y con
 * los empates al par. `Math.round(x * 100) / 100` y `toFixed` redondean los empates hacia arriba (p. ej. 3.25 → «3.3»
 * frente a «3.2» en Python), y los puntuajes de Karajan caen a menudo en 0.25/0.75.
 */
const ESCALA = 100;

function decimalExacto(x: number, nd: number): { negativo: boolean; q: bigint } {
  const negativo = x < 0 || Object.is(x, -0);
  const [entera, frac = ''] = Math.abs(x).toFixed(ESCALA).split('.');
  const todo = BigInt(entera + frac.padEnd(ESCALA, '0'));
  const potencia = 10n ** BigInt(ESCALA - nd);
  let q = todo / potencia;
  const resto = todo % potencia;
  const mitad = potencia / 2n;
  if (resto > mitad || (resto === mitad && q % 2n === 1n)) q += 1n;
  return { negativo, q };
}

export function redondear(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  const { negativo, q } = decimalExacto(x, nd);
  const n = Number(`${q}e-${nd}`);
  return negativo ? -n : n;
}

/** Equivale a `f"{x:.{nd}f}"`. */
export function formatear(x: number, nd: number): string {
  const { negativo, q } = decimalExacto(x, nd);
  const digitos = q.toString().padStart(nd + 1, '0');
  const texto = nd ? `${digitos.slice(0, -nd)}.${digitos.slice(-nd)}` : digitos;
  return negativo && q !== 0n ? `-${texto}` : texto;
}
