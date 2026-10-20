// Construye el paquete de Atlas dev (`dist-atlas/server.mjs`): el servidor de Karajan en un solo .mjs, sin dependencias.
// Uso: npm install --prefix atlas && node atlas/build.mjs   (lo llama el empaquetador de Atlas dev vía atlas-package.json).
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

let esbuild;
try { esbuild = await import('esbuild'); } catch {
  console.error('Falta esbuild: ejecuta «npm install --prefix atlas» y vuelve a empaquetar.');
  process.exit(1);
}
const raiz = resolve(import.meta.dirname, '..');
const salida = resolve(raiz, 'dist-atlas');
rmSync(salida, { recursive: true, force: true });
mkdirSync(salida, { recursive: true });
const comun = { bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning' };
await esbuild.build({ ...comun, entryPoints: [resolve(raiz, 'atlas/src/servidor.ts')], outfile: resolve(salida, 'server.mjs') });
// `kj`: Karajan desde la terminal (node dist-atlas/kj.mjs …).
await esbuild.build({ ...comun, entryPoints: [resolve(raiz, 'atlas/src/cli.ts')], outfile: resolve(salida, 'kj.mjs'), banner: { js: '#!/usr/bin/env node' } });
console.log('dist-atlas listo: server.mjs y kj.mjs');
