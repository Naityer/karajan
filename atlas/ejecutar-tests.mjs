// Empaqueta los tests con esbuild (los fuentes importan sin extensión) y los ejecuta con el runner de Node.
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const aqui = import.meta.dirname;
const salida = mkdtempSync(join(tmpdir(), 'karajan-atlas-tests-'));
try {
  await build({
    entryPoints: [resolve(aqui, 'tests/paridad.test.ts')], outfile: join(salida, 'paridad.test.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning',
    // import.meta.dirname del test debe seguir apuntando a atlas/tests (las fixtures no se copian al temporal).
    define: { 'import.meta.dirname': JSON.stringify(resolve(aqui, 'tests')) },
  });
  const r = spawnSync(process.execPath, ['--test', join(salida, 'paridad.test.mjs')], { stdio: 'inherit' });
  process.exitCode = r.status ?? 1;
} finally {
  rmSync(salida, { recursive: true, force: true });
}
