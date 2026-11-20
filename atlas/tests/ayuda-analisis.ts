import { Cadena, type Backend, type IdProveedor, type Sonda } from '../src/analisis/proveedores';

/** Backend simulado: sondas y respuestas por proveedor; cuenta las llamadas. */
export function falso(sondas: Partial<Record<IdProveedor, Sonda>>, respuestas: Partial<Record<IdProveedor, string | Error>>) {
  const llamadas: IdProveedor[] = [];
  const backend: Backend = {
    async sondear(id) { return sondas[id] ?? { ok: false, motivo: 'sin sonda' }; },
    async generar(id, modelo) {
      llamadas.push(id);
      const r = respuestas[id];
      if (r instanceof Error) return { salida: '', error: r.message, latenciaMs: 1, modelo };
      return { salida: r ?? '', error: r === undefined ? 'sin respuesta' : null, latenciaMs: 1, modelo };
    },
  };
  return { backend, llamadas };
}
export const OK: Sonda = { ok: true, motivo: null };
export const OPC = { permitirGemini: true, maxGeminiPorEjecucion: 5, timeoutMs: 1000 };
export const cadena = (b: Backend, opc = OPC) => new Cadena([{ id: 'ollama', modelo: 'qwen2.5:14b', activo: true }, { id: 'agy', modelo: null, activo: true }], opc, b);

