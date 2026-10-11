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
await esbuild.build({
  entryPoints: [resolve(raiz, 'atlas/src/servidor.ts')], outfile: resolve(salida, 'server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', legalComments: 'none', logLevel: 'warning',
});
console.log('dist-atlas listo: server.mjs');
