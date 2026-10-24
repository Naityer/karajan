import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { aislar, cerrar } from '../aislar-git';
import type { Hallazgo } from '../pasarela-borradores';
import type { ContextoLab, Laboratorio, Resultado } from '../laboratorio';

/**
 * Laboratorio del aislamiento git.
 *   ciclo      (repo git TEMPORAL) `aislar` crea el worktree y la rama agente/<id> sin ensuciar el repo, el trabajo se commitea con sus
 *              trailers en esa rama, `cerrar` quita el worktree y deja la rama, y `main` no se mueve; sin cambios la rama se borra;
 *              fuera de un repo no aísla nada.
 *   huerfanos  (solo lectura sobre el Workspace) worktrees cuya carpeta ya no existe y ramas agente/* ya integradas en la principal.
 *              Solo se miran con `git worktree list` y `git for-each-ref`: nada se poda ni se borra.
 */
export interface ContextoAislamiento extends ContextoLab {
  /** Carpeta del Workspace (sus repos son las subcarpetas con `.git`), o null si no se sabe. */
  workspace: string | null;
}

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return { ok: r.status === 0, salida: (r.stdout ?? '').trim(), error: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
};
const hayGit = () => git(tmpdir(), ['--version']).ok;

/** Prepara un repo con un commit y una identidad local (la del equipo podría exigir firma o no existir). */
function repoTemporal(dir: string): string {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  for (const a of [['init', '-q'], ['config', 'user.name', 'laboratorio'], ['config', 'user.email', 'lab@karajan.local'], ['config', 'commit.gpgsign', 'false']]) git(repo, a);
  writeFileSync(join(repo, 'base.txt'), 'base\n', 'utf8');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  return repo;
}

function ciclo(): Resultado {
  if (!hayGit()) return { muestra: 0, suficiente: false, metricas: { git: 0 }, hallazgos: [] };
  const dir = mkdtempSync(join(tmpdir(), 'karajan-lab-aislar-'));
  const fallos: string[] = [];
  const comprobar = (nombre: string, ok: boolean) => { if (!ok) fallos.push(nombre); };
  try {
    const repo = repoTemporal(dir);
    const cabeza = git(repo, ['rev-parse', 'HEAD']).salida;
    const a = aislar(repo, 'lab-1');
    comprobar('aislar devuelve el aislamiento', a !== null);
    if (a) {
      comprobar('rama agente/<id>', a.rama === 'agente/lab-1' && git(repo, ['rev-parse', '--verify', '--quiet', a.rama]).ok);
      comprobar('worktree creado', existsSync(join(a.worktree, 'base.txt')));
      comprobar('el repo no ve .trabajo/ como cambio', git(repo, ['status', '--porcelain']).salida === '');
      writeFileSync(join(a.worktree, 'trabajo.txt'), 'hecho\n', 'utf8');
      const c = cerrar(a, { mensaje: 'lab: trabajo del agente', subir: false, quien: 'laboratorio' });
      comprobar('cerrar commitea', c.commit !== null && c.error === null);
      comprobar('cerrar quita el worktree', !existsSync(a.worktree));
      comprobar('la rama se queda con el commit', git(repo, ['rev-parse', a.rama]).salida === c.commit);
      const mensaje = git(repo, ['log', '-1', '--format=%B', a.rama]).salida;
      comprobar('trailers Equipo y Karajan-Tarea', /Equipo: laboratorio/.test(mensaje) && /Karajan-Tarea: lab-1/.test(mensaje));
      comprobar('main no se mueve', git(repo, ['rev-parse', 'HEAD']).salida === cabeza && git(repo, ['rev-parse', `${a.rama}~1`]).salida === cabeza);
    }
    const b = aislar(repo, 'lab-2');
    comprobar('segundo aislamiento', b !== null);
    if (b) {
      const c = cerrar(b, { mensaje: 'sin cambios', subir: false, quien: 'laboratorio' });
      comprobar('sin cambios no hay commit', c.commit === null && c.error === null);
      comprobar('sin cambios la rama se borra', !git(repo, ['rev-parse', '--verify', '--quiet', b.rama]).ok && !existsSync(b.worktree));
    }
    const fuera = join(dir, 'fuera');
    mkdirSync(fuera);
    comprobar('fuera de un repo no aísla', aislar(fuera, 'lab-3') === null);
  } catch (e) {
    fallos.push(`excepción: ${String((e as Error).message ?? e).slice(0, 200)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    muestra: 1, suficiente: true, metricas: { comprobaciones_fallidas: fallos.length }, umbrales: { comprobaciones_fallidas: '= 0' }, detalle: { fallos },
    hallazgos: fallos.length ? [{
      clave: 'ciclo-roto', severidad: 'alta', titulo: 'El aislamiento git no cumple su ciclo en un repo temporal',
      evidencia: `Fallan: ${fallos.join('; ')}.`, propuesta: 'Revisar `aislar` y `cerrar` en `atlas/src/aislar-git.ts` (worktree, rama agente/<id>, trailers, limpieza).',
    }] : [],
  };
}

/** Los repos del Workspace: sus subcarpetas con un `.git` de verdad (los worktrees llevan un fichero y repetirían la lista de su repo). */
function reposDe(workspace: string): string[] {
  try { return readdirSync(workspace, { withFileTypes: true }).filter((d) => d.isDirectory() && statSync(join(workspace, d.name, '.git'), { throwIfNoEntry: false })?.isDirectory()).map((d) => join(workspace, d.name)); } catch { return []; }
}

function huerfanos(ctx: ContextoAislamiento): Resultado {
  if (!ctx.workspace || !hayGit()) return { muestra: 0, suficiente: false, metricas: { repos: 0 }, hallazgos: [] };
  const repos = reposDe(ctx.workspace);
  let worktrees = 0, sinCarpeta = 0, vivos = 0, ramas = 0, integradas = 0;
  const detalle: { repo: string; worktrees_sin_carpeta: number; ramas_integradas: number }[] = [];
  for (const repo of repos) {
    const lista = git(repo, ['worktree', 'list', '--porcelain']);
    // Entradas separadas por línea en blanco; el principal es la primera. Un worktree cuya carpeta ya no existe está listo para `git worktree prune`.
    const entradas = lista.ok ? lista.salida.split(/\r?\n\r?\n/).slice(1).map((e) => /^worktree (.+)$/m.exec(e)?.[1]).filter((x): x is string => !!x) : [];
    const rotos = entradas.filter((w) => !existsSync(w)).length;
    worktrees += entradas.length; sinCarpeta += rotos; vivos += entradas.length - rotos;
    const principal = ['main', 'master'].find((r) => git(repo, ['rev-parse', '--verify', '--quiet', r]).ok);
    const todas = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/agente/']).salida.split(/\r?\n/).filter(Boolean);
    const hechas = principal ? new Set(git(repo, ['branch', '--merged', principal, '--format=%(refname:short)']).salida.split(/\r?\n/).filter((r) => r.startsWith('agente/'))) : new Set<string>();
    ramas += todas.length; integradas += hechas.size;
    if (rotos || hechas.size) detalle.push({ repo: repo.split(/[\\/]/).pop()!, worktrees_sin_carpeta: rotos, ramas_integradas: hechas.size });
  }
  const hallazgos: Hallazgo[] = [];
  if (sinCarpeta) hallazgos.push({
    clave: 'worktrees-sin-carpeta', severidad: 'baja', titulo: `${sinCarpeta} worktrees del Workspace apuntan a carpetas que ya no existen`,
    evidencia: detalle.filter((d) => d.worktrees_sin_carpeta).map((d) => `- ${d.repo}: ${d.worktrees_sin_carpeta}`).join('\n'), propuesta: 'Ejecutar `git worktree prune` en esos repos (el laboratorio no poda nada).',
  });
  if (integradas) hallazgos.push({
    clave: 'ramas-integradas', severidad: 'baja', titulo: `${integradas} ramas agente/* ya están integradas en la principal`,
    evidencia: detalle.filter((d) => d.ramas_integradas).map((d) => `- ${d.repo}: ${d.ramas_integradas}`).join('\n'), propuesta: 'Borrarlas con `git branch -d` tras confirmar que `integrar-ramas` ya las recogió.',
  });
  return {
    muestra: repos.length, suficiente: repos.length > 0, hallazgos,
    metricas: { repos: repos.length, worktrees: worktrees, worktrees_vivos: vivos, worktrees_sin_carpeta: sinCarpeta, ramas_agente: ramas, ramas_integradas: integradas },
    umbrales: { worktrees_sin_carpeta: '= 0 (aviso)', ramas_integradas: '= 0 (aviso)' }, detalle: { repos: detalle },
  };
}

export const laboratorioAislamiento: Laboratorio<ContextoAislamiento> = {
  escenarios: [
    { id: 'ciclo', tipo: 'contrato', descripcion: 'En un repo temporal: worktree + rama agente/<id>, trabajo commiteado con trailers, cierre y limpieza sin mover main', ejecutar: () => ciclo() },
    { id: 'huerfanos', tipo: 'contrato', descripcion: 'Solo lectura: worktrees sin carpeta y ramas agente/* ya integradas en los repos del Workspace', ejecutar: (c) => huerfanos(c) },
  ],
};
