import { execFile, spawnSync } from 'node:child_process';

import { buscarBinario, ejecutarProveedor, motivoFallo, type Proveedor, type ResultadoEjecucion } from '../proveedores';

/**
 * Modelos con los que se etiqueta, en orden de preferencia y por coste:
 *   1. `ollama` (local, sin coste): modelo configurable, por defecto qwen2.5:14b.
 *   2. `agy` (Gemini vía Antigravity CLI, cuenta de Google): SOLO si la sonda confirma sesión iniciada y la configuración lo permite.
 *      Sus límites y su coste dependen del plan de la cuenta y no se pueden leer desde la CLI: por eso hay un tope de llamadas por
 *      ejecución (`maxGeminiPorEjecucion`) y nunca se asume que sea gratis.
 *   3. `claude-cli` / `codex` (cuentas de pago): no están en la cadena por defecto; solo los usa la destilación si se configura.
 * Si nadie está disponible la tarea queda `pendiente` y se reintenta: no se inventa nada.
 */
export type IdProveedor = 'ollama' | 'agy' | 'claude-cli' | 'codex';
export type CosteProveedor = 'local' | 'cuenta-google' | 'pago';
export const COSTE: Record<IdProveedor, CosteProveedor> = { ollama: 'local', agy: 'cuenta-google', 'claude-cli': 'pago', codex: 'pago' };

export interface EntradaCadena { id: IdProveedor; modelo: string | null; activo: boolean }
export interface Sonda { ok: boolean; motivo: string | null }
export interface Respuesta { salida: string; error: string | null; latenciaMs: number; modelo: string | null }

/** Costuras para los tests: la sonda y la ejecución se sustituyen sin tocar procesos reales. */
export interface Backend {
  sondear(id: IdProveedor, modelo: string | null): Promise<Sonda>;
  generar(id: IdProveedor, modelo: string | null, prompt: string, timeoutMs: number): Promise<Respuesta>;
}

const PROV_OLLAMA: Proveedor = { nombre: 'ollama', etiqueta: 'Ollama (local)', binario: 'ollama', gratis: true, login: 'ollama serve', modelos: {}, args: (m) => ['run', m, '--nowordwrap'] };
const PROV_CLAUDE: Proveedor = { nombre: 'claude-cli', etiqueta: 'Claude Code CLI', binario: 'claude', gratis: false, login: 'claude /login', modelos: {}, args: (m) => ['-p', '--model', m, '--output-format', 'text'] };
const PROV_CODEX: Proveedor = { nombre: 'codex', etiqueta: 'Codex CLI', binario: 'codex', gratis: false, login: 'codex login', modelos: {}, args: () => ['exec', '--ephemeral', '--color', 'never', '--skip-git-repo-check', '-'] };

const deEjecucion = (r: ResultadoEjecucion): Respuesta => ({ salida: r.salida, error: r.error, latenciaMs: r.latenciaMs, modelo: r.modelo });

function ejecutarArchivo(ruta: string, args: string[], timeoutMs: number): Promise<{ salida: string; error: string | null; latenciaMs: number }> {
  const inicio = Date.now();
  return new Promise((resolver) => {
    execFile(ruta, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      const salida = String(stdout ?? '').trim();
      resolver({ salida, error: error ? motivoFallo(String(stderr ?? '') || error.message) : null, latenciaMs: Date.now() - inicio });
    });
  });
}

/** Backend real: procesos locales, sin shell. `agy` recibe el prompt como argumento (`agy -p`), como hace el chat de Atlas dev. */
export const backendReal: Backend = {
  async sondear(id, modelo) {
    const ruta = buscarBinario(id === 'agy' ? 'agy' : id === 'claude-cli' ? 'claude' : id);
    if (!ruta) return { ok: false, motivo: `«${id}» no está en el PATH` };
    if (id === 'ollama') {
      const r = spawnSync(ruta, ['list'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status !== 0) return { ok: false, motivo: 'ollama no responde (¿está «ollama serve» en marcha?)' };
      if (modelo && !String(r.stdout).split(/\r?\n/).some((l) => l.trim().split(/\s+/)[0] === modelo || l.trim().split(/\s+/)[0] === `${modelo}:latest`)) return { ok: false, motivo: `falta el modelo: ollama pull ${modelo}` };
      return { ok: true, motivo: null };
    }
    if (id === 'agy') {
      // `agy models` solo lista modelos con sesión iniciada: sirve de sonda de cuenta conectada.
      const r = await ejecutarArchivo(ruta, ['models'], 30_000);
      const modelos = r.salida.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^fetching/i.test(l));
      return r.error || !modelos.length ? { ok: false, motivo: r.error ?? 'agy sin sesión iniciada (inicia sesión en la CLI)' } : { ok: true, motivo: null };
    }
    return { ok: true, motivo: null };
  },
  async generar(id, modelo, prompt, timeoutMs) {
    if (id === 'agy') {
      const ruta = buscarBinario('agy');
      if (!ruta) return { salida: '', error: '«agy» no está en el PATH', latenciaMs: 0, modelo };
      const r = await ejecutarArchivo(ruta, ['-p', prompt, ...(modelo ? ['--model', modelo] : [])], timeoutMs);
      return { salida: r.salida, error: r.salida ? null : r.error ?? 'sin salida', latenciaMs: r.latenciaMs, modelo };
    }
    const p = id === 'ollama' ? PROV_OLLAMA : id === 'codex' ? PROV_CODEX : PROV_CLAUDE;
    return deEjecucion(await ejecutarProveedor(p, modelo ?? 'default', prompt, { cwd: process.cwd(), timeoutMs }));
  },
};

export interface Intento { proveedor: IdProveedor; modelo: string | null; coste: CosteProveedor; resultado: 'usado' | 'no_disponible' | 'omitido' | 'error'; detalle: string | null }

export interface OpcionesCadena { permitirGemini: boolean; maxGeminiPorEjecucion: number; timeoutMs: number }

/**
 * Cadena de proveedores: prueba cada uno en orden y devuelve el primer resultado que `valida` acepta. Anota cada intento (por
 * qué se saltó o falló), para que la procedencia y los fallos queden registrados.
 */
export class Cadena {
  private geminiUsado = 0;
  private sondas = new Map<string, Sonda>();
  constructor(private readonly entradas: EntradaCadena[], private readonly opciones: OpcionesCadena, private readonly backend: Backend = backendReal) {}

  private async sonda(e: EntradaCadena): Promise<Sonda> {
    const k = `${e.id}:${e.modelo}`;
    let s = this.sondas.get(k);
    if (!s) { s = await this.backend.sondear(e.id, e.modelo).catch((err: Error) => ({ ok: false, motivo: err.message })); this.sondas.set(k, s); }
    return s;
  }

  async generar<T>(prompt: string, valida: (salida: string) => T | null): Promise<{ valor: T | null; proveedor: IdProveedor | null; modelo: string | null; intentos: Intento[]; alguienRespondio: boolean }> {
    const intentos: Intento[] = [];
    let alguienRespondio = false;
    for (const e of this.entradas) {
      const base = { proveedor: e.id, modelo: e.modelo, coste: COSTE[e.id] };
      if (!e.activo) { intentos.push({ ...base, resultado: 'omitido', detalle: 'desactivado en la configuración' }); continue; }
      if (e.id === 'agy' && !this.opciones.permitirGemini) { intentos.push({ ...base, resultado: 'omitido', detalle: 'Gemini no permitido (permitirGemini=false)' }); continue; }
      if (e.id === 'agy' && this.geminiUsado >= this.opciones.maxGeminiPorEjecucion) { intentos.push({ ...base, resultado: 'omitido', detalle: `tope de ${this.opciones.maxGeminiPorEjecucion} llamadas a Gemini por ejecución` }); continue; }
      const s = await this.sonda(e);
      if (!s.ok) { intentos.push({ ...base, resultado: 'no_disponible', detalle: s.motivo }); continue; }
      if (e.id === 'agy') this.geminiUsado++;
      const r = await this.backend.generar(e.id, e.modelo, prompt, this.opciones.timeoutMs).catch((err: Error) => ({ salida: '', error: err.message, latenciaMs: 0, modelo: e.modelo }));
      alguienRespondio = true;
      if (r.error && !r.salida) { intentos.push({ ...base, resultado: 'error', detalle: r.error.slice(0, 300) }); continue; }
      const valor = valida(r.salida);
      if (valor === null) { intentos.push({ ...base, resultado: 'error', detalle: 'respuesta no válida (no es el JSON esperado)' }); continue; }
      intentos.push({ ...base, resultado: 'usado', detalle: null });
      return { valor, proveedor: e.id, modelo: r.modelo ?? e.modelo, intentos, alguienRespondio };
    }
    return { valor: null, proveedor: null, modelo: null, intentos, alguienRespondio };
  }
}
