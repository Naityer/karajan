import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Proveedores CLI que el paquete sabe ejecutar: los tres del perfil por dominio (Claude Code, Codex y Qwen con ollama). Los
 * comandos y los modelos por nivel son los de `app/catalog.py`. Se ejecutan como subproceso, SIN shell y con argumentos fijos:
 * la instrucción va por stdin, así que nada de lo que escriba el usuario llega a la línea de comandos.
 */
export type Tier = 'cheap_model' | 'cheap_or_medium_model' | 'medium_model' | 'strong_model' | 'strong_model_with_human_review';

export interface Proveedor { nombre: string; etiqueta: string; binario: string; gratis: boolean; modelos: Partial<Record<Tier, string>>; args: (modelo: string) => string[]; login: string; modeloLocal?: string }

export const PROVEEDORES: Proveedor[] = [
  {
    nombre: 'claude-cli', etiqueta: 'Claude Code CLI (local)', binario: 'claude', gratis: false, login: 'claude /login',
    modelos: { cheap_model: 'haiku', cheap_or_medium_model: 'haiku', medium_model: 'haiku', strong_model: 'sonnet', strong_model_with_human_review: 'opus' },
    args: (m) => ['-p', '--model', m, '--output-format', 'text'],
  },
  {
    nombre: 'codex', etiqueta: 'OpenAI Codex CLI (local)', binario: 'codex', gratis: false, login: 'codex login',
    modelos: { cheap_model: 'default', cheap_or_medium_model: 'default', medium_model: 'default', strong_model: 'default', strong_model_with_human_review: 'default' },
    args: () => ['exec', '--ephemeral', '--color', 'never', '-'],
  },
  {
    nombre: 'ollama-qwen', etiqueta: 'Qwen (local)', binario: 'ollama', gratis: true, login: 'ollama serve', modeloLocal: 'qwen2.5:7b',
    modelos: { cheap_model: 'qwen2.5:7b', cheap_or_medium_model: 'qwen2.5:7b' },
    args: (m) => ['run', m, '--nowordwrap'],
  },
];

export const proveedor = (nombre: string | null | undefined) => PROVEEDORES.find((p) => p.nombre === nombre) ?? null;

/** Modelo para un nivel; si el proveedor no cubre ese nivel, su primer modelo (como `resolve_by_name`). */
export function modeloPara(p: Proveedor, tier: Tier): string {
  return p.modelos[tier] ?? Object.values(p.modelos)[0]!;
}

/** Como `shutil.which` más las carpetas globales de npm en Windows (donde se instalan `claude` y `codex`). */
export function buscarBinario(binario: string, entorno: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = (entorno['PATH'] ?? entorno['Path'] ?? '').split(delimiter).filter(Boolean);
  if (process.platform === 'win32') for (const v of ['APPDATA', 'LOCALAPPDATA']) if (entorno[v]) dirs.push(join(entorno[v]!, 'npm'));
  const exts = process.platform === 'win32' ? (entorno['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase()).concat(['']) : [''];
  for (const d of dirs) for (const e of exts) { const r = join(d, binario + e); if (existsSync(r)) return r; }
  return null;
}

export interface Disponibilidad { nombre: string; etiqueta: string; gratis: boolean; disponible: boolean; ruta: string | null; motivo: string | null; login: string }

export function disponibilidad(p: Proveedor, ejecutar = spawnSync): Disponibilidad {
  const ruta = buscarBinario(p.binario);
  if (!ruta) return { nombre: p.nombre, etiqueta: p.etiqueta, gratis: p.gratis, disponible: false, ruta: null, motivo: `«${p.binario}» no está en el PATH`, login: p.login };
  if (p.modeloLocal) {
    const r = ejecutar(ruta, ['list'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const lista = String(r.stdout ?? '');
    if (r.status !== 0) return { nombre: p.nombre, etiqueta: p.etiqueta, gratis: p.gratis, disponible: false, ruta, motivo: 'ollama no responde (¿está «ollama serve» en marcha?)', login: p.login };
    if (!lista.includes(p.modeloLocal)) return { nombre: p.nombre, etiqueta: p.etiqueta, gratis: p.gratis, disponible: false, ruta, motivo: `falta el modelo: ollama pull ${p.modeloLocal}`, login: p.login };
  }
  return { nombre: p.nombre, etiqueta: p.etiqueta, gratis: p.gratis, disponible: true, ruta, motivo: null, login: p.login };
}

export interface ResultadoEjecucion { salida: string; error: string | null; latenciaMs: number; modelo: string }
export type Ejecutor = (p: Proveedor, modelo: string, instruccion: string, op: { cwd: string; timeoutMs: number }) => Promise<ResultadoEjecucion>;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

/** Ejecuta de verdad un proveedor. En Windows los `.cmd` de npm necesitan `cmd.exe /d /s /c` (los argumentos son fijos). */
export const ejecutarProveedor: Ejecutor = (p, modelo, instruccion, { cwd, timeoutMs }) => new Promise((resolver) => {
  const inicio = Date.now();
  const ruta = buscarBinario(p.binario);
  if (!ruta) { resolver({ salida: '', error: `«${p.binario}» no está en el PATH`, latenciaMs: 0, modelo }); return; }
  const args = p.args(modelo);
  const esScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(ruta);
  const hijo = esScript
    ? spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', `"${ruta}" ${args.map((a) => (/^[\w.:-]+$/.test(a) ? a : `"${a}"`)).join(' ')}`], { cwd, windowsHide: true, windowsVerbatimArguments: true })
    : spawn(ruta, args, { cwd, windowsHide: true });
  let salida = '', error = '';
  const reloj = setTimeout(() => { error = `tiempo agotado (${Math.round(timeoutMs / 1000)} s)`; hijo.kill(); }, timeoutMs);
  hijo.stdout.on('data', (c: Buffer) => { salida += c.toString('utf8'); });
  hijo.stderr.on('data', (c: Buffer) => { error += c.toString('utf8'); });
  hijo.on('error', (e) => { clearTimeout(reloj); resolver({ salida: '', error: e.message, latenciaMs: Date.now() - inicio, modelo }); });
  hijo.on('close', (codigo) => {
    clearTimeout(reloj);
    const limpia = salida.replace(ANSI, '').trim();
    resolver({ salida: limpia, error: codigo === 0 && limpia ? null : (error.replace(ANSI, '').trim() || `terminó con código ${codigo}`).slice(0, 2000), latenciaMs: Date.now() - inicio, modelo });
  });
  hijo.stdin.end(instruccion, 'utf8');
});
