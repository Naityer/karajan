// Arnés de desarrollo de la UI: construye la ventana con los datos de ejemplo (ui/fixtures) y la sirve sin Atlas dev.
// Uso: node atlas/ui/dev.mjs [puerto]   y abre http://localhost:4260/?demo=1   (añade &tema=dark para el tema oscuro).
// El panel sí/no de skills: http://localhost:4260/?vista=skills (rutas simuladas con fixtures/skills.json; reinicia el arnés para olvidar las respuestas).
// GET /rebuild reconstruye el bundle sin reiniciar el servidor. No toca dist-atlas: todo va a atlas/node_modules/.cache/kj-dev.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const aqui = import.meta.dirname;
const salida = resolve(aqui, '..', 'node_modules/.cache/kj-dev');
mkdirSync(salida, { recursive: true });
const puerto = Number(process.argv[2] ?? 4260);

// El paquete, igual que en atlas/build.mjs pero con los datos de ejemplo dentro (__KJ_DEMO__ = true) y sin minificar.
const compartidas = { react: 'React', 'react/jsx-runtime': 'jsxRuntime', recharts: 'recharts' };
const externos = {
  name: 'atlas-compartido',
  setup(b) {
    b.onResolve({ filter: /^(react|react\/jsx-runtime|recharts)$/ }, (a) => ({ path: a.path, namespace: 'atlas-compartido' }));
    b.onLoad({ filter: /.*/, namespace: 'atlas-compartido' }, (a) => ({ contents: `module.exports = window.AtlasShared.${compartidas[a.path]};`, loader: 'js' }));
  },
};
async function construir() {
  await build({ entryPoints: [resolve(aqui, 'ui.tsx')], outfile: resolve(salida, 'ui.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', define: { __KJ_DEMO__: 'true' }, plugins: [externos], sourcemap: 'inline', logLevel: 'warning' });
  // El arnés SÍ lleva su propio React: hace de Atlas dev.
  await build({ entryPoints: [resolve(aqui, 'dev/shared.tsx')], outfile: resolve(salida, 'shared.js'), bundle: true, platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"development"' }, logLevel: 'warning' });
  copyFileSync(resolve(aqui, 'dev/tokens.css'), resolve(salida, 'tokens.css'));
}
await construir();

const pagina = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Karajan · arnés de la UI</title>
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/ui.css"></head>
<body><div class="arnes"><aside id="panel"></aside><main id="pagina"></main></div>
<script src="/shared.js"></script><script src="/ui.js"></script><script>montarKarajan()</script></body></html>`;
const tipos = { '.js': 'text/javascript', '.css': 'text/css' };
const demoSkills = JSON.parse(readFileSync(resolve(aqui, 'fixtures/skills.json'), 'utf8'));
const calibradas = new Map(); // en memoria: se pierde al reiniciar el arnés
function simularApi(req, res, ruta) {
  const url = new URL(req.url, 'http://x'), json = (o, c = 200) => { res.statusCode = c; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  if (ruta.endsWith('/sugerencias-skills') && req.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    const sugeridas = demoSkills.catalogo.filter((t) => t.puntos !== null).sort((a, b) => b.puntos - a.puntos);
    const encontradas = q ? demoSkills.catalogo.filter((t) => `${t.nombre} ${t.descripcion}`.toLowerCase().includes(q)) : [];
    return void setTimeout(() => json({ sugeridas, encontradas, biblioteca: true }), 150);
  }
  if (ruta.endsWith('/calibracion') && req.method === 'GET') return json(calibradas.get(url.searchParams.get('tarea')) ?? { calibrada: false });
  if (ruta.endsWith('/calibracion') && req.method === 'POST') {
    let cuerpo = ''; req.on('data', (d) => { cuerpo += d; });
    return void req.on('end', () => { const b = JSON.parse(cuerpo || '{}'); console.log('calibración (simulada):', JSON.stringify(b)); calibradas.set(b.tarea, { calibrada: true, ...b }); json({ guardada: true, descartadas: [] }); });
  }
  json({ error: 'no simulada' }, 404);
}
createServer((req, res) => {
  const ruta = new URL(req.url, 'http://x').pathname;
  if (ruta === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end(pagina); }
  if (ruta === '/k1.json') { try { res.setHeader('content-type', 'application/json'); return res.end(readFileSync(process.env.KJ_FIXTURE ?? '')); } catch { res.statusCode = 404; return res.end('no'); } }
  // Simula las rutas del servidor que usa el panel de skills (con fixtures/skills.json): sin servidor real ni escritura.
  if (ruta.startsWith('/paquetes/karajan/api/laboratorio/')) return simularApi(req, res, ruta);
  if (ruta === '/rebuild') { construir().then(() => res.end('ok'), (e) => { res.statusCode = 500; res.end(String(e)); }); return; }
  const ext = ruta.slice(ruta.lastIndexOf('.'));
  if (!tipos[ext] || ruta.includes('..')) { res.statusCode = 404; return res.end('no'); }
  try { res.setHeader('content-type', tipos[ext]); res.setHeader('cache-control', 'no-store'); res.end(readFileSync(resolve(salida, '.' + ruta))); } catch { res.statusCode = 404; res.end('no'); }
}).listen(puerto, () => console.log(`Arnés de Karajan en http://localhost:${puerto}/?demo=1  (GET /rebuild reconstruye)`));
