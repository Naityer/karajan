// Empaqueta los tests con esbuild (los fuentes importan sin extensión) y los ejecuta con el runner de Node.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const aqui = import.meta.dirname;
const salida = mkdtempSync(join(tmpdir(), 'karajan-atlas-tests-'));
try {
  await build({
    entryPoints: readdirSync(resolve(aqui, 'tests')).filter((f) => f.endsWith('.test.ts')).map((f) => resolve(aqui, 'tests', f)), outdir: salida, outExtension: { '.js': '.mjs' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
    // import.meta.dirname del test debe seguir apuntando a atlas/tests (las fixtures no se copian al temporal).
    define: { 'import.meta.dirname': JSON.stringify(resolve(aqui, 'tests')) },
  });
  const tests = readdirSync(salida).filter((f) => f.endsWith('.test.mjs')).map((f) => join(salida, f));
  const r = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(salida, { recursive: true, force: true });
}
