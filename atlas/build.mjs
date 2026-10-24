// Construye el paquete de Atlas dev (`dist-atlas/`): el servidor de Karajan en un solo .mjs, `kj` y la UI (`ui.js` + `ui.css`).
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

// UI de la ventana: React, su runtime JSX y recharts los pone Atlas dev (window.AtlasShared), de modo que no se empaquetan aquí.
// `__KJ_DEMO__` es false: los datos de ejemplo (ui/fixtures) solo entran en el arnés de desarrollo (ui/dev.mjs).
const compartidas = { react: 'React', 'react/jsx-runtime': 'jsxRuntime', recharts: 'recharts' };
export const plugins = [{
  name: 'atlas-compartido',
  setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|recharts)$/ }, (a) => ({ path: a.path, namespace: 'atlas-compartido' }));
    b.onLoad({ filter: /.*/, namespace: 'atlas-compartido' }, (a) => ({ contents: `module.exports = window.AtlasShared.${compartidas[a.path]};`, loader: 'js' }));
  },
}];
await esbuild.build({
  entryPoints: [resolve(raiz, 'atlas/ui/ui.tsx')], outfile: resolve(salida, 'ui.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022',
  minify: true, legalComments: 'none', jsx: 'automatic', define: { __KJ_DEMO__: 'false' }, plugins, logLevel: 'warning',
});
console.log('dist-atlas listo: server.mjs, kj.mjs, ui.js y ui.css');
