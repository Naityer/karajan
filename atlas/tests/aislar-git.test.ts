import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { aislar, cerrar } from '../src/aislar-git';

/** Un origen bare con `main` y un clon: lo mismo que tiene el servidor en /srv/workspace. */
const raiz = mkdtempSync(join(tmpdir(), 'karajan-git-'));
after(() => rmSync(raiz, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=Prueba', '-c', 'user.email=prueba@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const origen = join(raiz, 'origen.git');
const clon = join(raiz, 'repo');
git(raiz, 'init', '--quiet', '--bare', '-b', 'main', origen);
git(raiz, 'clone', '--quiet', origen, clon);
mkdirSync(join(clon, 'web'));
writeFileSync(join(clon, 'web', 'a.txt'), 'uno\n');
git(clon, 'add', '-A');
git(clon, 'commit', '--quiet', '-m', 'inicio');
git(clon, 'push', '--quiet', 'origin', 'HEAD:main');
process.env['GIT_AUTHOR_NAME'] = process.env['GIT_COMMITTER_NAME'] = 'Prueba';
process.env['GIT_AUTHOR_EMAIL'] = process.env['GIT_COMMITTER_EMAIL'] = 'prueba@example.com';

describe('aislamiento git de las tareas de agente', () => {
  it('trabaja en un worktree con su rama, commitea con el equipo y la sube sin tocar main', () => {
    const a = aislar(join(clon, 'web'), 'tsk_uno')!;
    assert.equal(a.rama, 'agente/tsk_uno');
    assert.equal(a.base, 'origin/main');
    assert.ok(a.carpeta.endsWith(join('.trabajo', 'tsk_uno', 'web')));
    writeFileSync(join(a.carpeta, 'a.txt'), 'dos\n');
    // El worktree no ensucia el repo principal.
    assert.equal(git(clon, 'status', '--porcelain'), '');
    const k = cerrar(a, { mensaje: 'karajan: cambia a.txt', quien: 'servidor' });
    assert.equal(k.error, null);
    assert.equal(k.subida, true);
    assert.ok(k.commit);
    assert.equal(existsSync(a.worktree), false);
    assert.match(git(origen, 'log', '-1', '--format=%B', 'agente/tsk_uno'), /Equipo: servidor\s+Karajan-Tarea: tsk_uno/);
    assert.equal(readFileSync(join(clon, 'web', 'a.txt'), 'utf8'), 'uno\n');
    assert.equal(git(origen, 'rev-parse', 'main'), git(clon, 'rev-parse', 'HEAD'));
  });

  it('sin cambios no deja rama, y fuera de un repo no aísla nada', () => {
    const a = aislar(clon, 'tsk_dos')!;
    const k = cerrar(a, { mensaje: 'nada', quien: 'servidor' });
    assert.deepEqual(k, { commit: null, subida: false, error: null });
    assert.equal(git(clon, 'branch', '--list', 'agente/tsk_dos'), '');
    const suelta = join(raiz, 'suelta');
    mkdirSync(suelta);
    assert.equal(aislar(suelta, 'tsk_tres'), null);
  });
});
