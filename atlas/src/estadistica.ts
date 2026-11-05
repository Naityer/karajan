/** Estadística común (módulo compartido, de ningún componente): la usan los laboratorios y la nota de la tutoría. */
/** Intervalo de Wilson (95 %) de una proporción k/n: [inferior, superior]. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n, d = 1 + (z * z) / n;
  const centro = (p + (z * z) / (2 * n)) / d, margen = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, centro - margen), Math.min(1, centro + margen)];
}

export const proporcion = (k: number, n: number) => (n ? Math.round((k / n) * 1000) / 1000 : null);
