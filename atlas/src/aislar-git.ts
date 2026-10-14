import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

/**
 * Aislamiento git de las tareas de agente (`KARAJAN_AISLAR_GIT=1`, activo en el servidor): antes de ejecutar se crea un worktree
 * `<repo>/.trabajo/<task_id>` con la rama `agente/<task_id>` desde `origin/main` (o desde HEAD si no hay remoto), el agente trabaja
 * ahí y, al terminar, lo que haya cambiado se commitea con los trailers `Equipo:` y `Karajan-Tarea:` y se sube la rama. `main` no
 * se toca nunca: lo integra el script nocturno `integrar-ramas` (rebase + tests + fast-forward). Si la carpeta no es un repo git,
 * no se aísla nada y el agente trabaja donde se le pidió.
 */
export interface Aislamiento { repo: string; worktree: string; rama: string; carpeta: string; base: string; taskId: string }
export interface Cierre { commit: string | null; subida: boolean; error: string | null }

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { ok: r.status === 0, salida: (r.stdout ?? '').trim(), error: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
};

/** Quién trabaja: `KARAJAN_EQUIPO`, el `id` de `~/.atlas-dev/equipo.json` o el nombre de la máquina. */
export function equipo(casa = homedir()): string {
  if (process.env['KARAJAN_EQUIPO']) return process.env['KARAJAN_EQUIPO'];
  try {
    const e = JSON.parse(readFileSync(join(process.env['ATLAS_DEV_DATA'] ?? join(casa, '.atlas-dev'), 'equipo.json'), 'utf8')) as { id?: unknown };
    if (typeof e.id === 'string' && e.id) return e.id;
  } catch { /* sin identidad: el nombre de la máquina */ }
  return hostname().toLowerCase();
}

export const aislarActivo = () => process.env['KARAJAN_AISLAR_GIT'] === '1';

export function aislar(cwd: string, taskId: string): Aislamiento | null {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !top.salida) return null;
  const repo = top.salida;
  // Que la carpeta de trabajo no aparezca como cambio sin seguimiento en el repo principal.
  const exclude = git(repo, ['rev-parse', '--git-path', 'info/exclude']).salida;
  if (exclude) {
    const ruta = isAbsolute(exclude) ? exclude : join(repo, exclude);
    const actual = existsSync(ruta) ? readFileSync(ruta, 'utf8') : '';
    if (!actual.split(/\r?\n/).includes('/.trabajo/')) { mkdirSync(dirname(ruta), { recursive: true }); appendFileSync(ruta, `${actual && !actual.endsWith('\n') ? '\n' : ''}/.trabajo/\n`); }
  }
  const remoto = git(repo, ['remote']).salida.split(/\s+/).includes('origin');
  if (remoto) git(repo, ['fetch', '--quiet', 'origin', 'main']);
  const base = remoto && git(repo, ['rev-parse', '--verify', '--quiet', 'origin/main']).ok ? 'origin/main' : 'HEAD';
  const rama = `agente/${taskId}`;
  const worktree = join(repo, '.trabajo', taskId);
  const r = git(repo, ['worktree', 'add', '-b', rama, worktree, base]);
  if (!r.ok) throw new Error(`No se pudo crear el worktree de ${rama}: ${r.error}`);
  return { repo, worktree, rama, base, taskId, carpeta: join(worktree, relative(repo, cwd)) };
}

/** Commitea lo que haya hecho el agente, sube la rama (si hay `origin` y `subir`) y quita el worktree; la rama se queda. */
export function cerrar(a: Aislamiento, { mensaje, subir = true, quien = equipo() }: { mensaje: string; subir?: boolean; quien?: string }): Cierre {
  let commit: string | null = null, subida = false, error: string | null = null;
  git(a.worktree, ['add', '-A']);
  if (!git(a.worktree, ['diff', '--cached', '--quiet']).ok) {
    const titulo = mensaje.split(/\r?\n/)[0]!.slice(0, 72) || `karajan: ${a.taskId}`;
    const c = git(a.worktree, ['commit', '--quiet', '-m', titulo, '-m', `Equipo: ${quien}\nKarajan-Tarea: ${a.taskId}`]);
    if (c.ok) commit = git(a.worktree, ['rev-parse', 'HEAD']).salida;
    else error = `commit: ${c.error}`;
  }
  if (commit && subir && git(a.repo, ['remote']).salida.split(/\s+/).includes('origin')) {
    const p = git(a.worktree, ['push', '--quiet', '-u', 'origin', a.rama]);
    subida = p.ok;
    if (!p.ok) error = `push: ${p.error}`;
  }
  git(a.repo, ['worktree', 'remove', '--force', a.worktree]);
  // Sin cambios, la rama no aporta nada: se borra para no dejar ramas vacías.
  if (!commit && !error) git(a.repo, ['branch', '-D', a.rama]);
  return { commit, subida, error };
}
