// Medición indicativa, sin LLM, disco por tarea ni proveedores. Usa un inventario sintético amplio.
// node scripts/medir-especialistas.mjs
import { build } from '../atlas/node_modules/esbuild/lib/main.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = mkdtempSync(join(tmpdir(), 'karajan-especialistas-medida-'));
try {
  const archivo = join(dir, 'especialistas.mjs');
  await build({ entryPoints: [new URL('../atlas/src/especialistas.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], outfile: archivo, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning' });
  const { CONFIG_ESPECIALISTAS: c, elegirEspecialista, inventarioConCache } = await import(pathToFileURL(archivo));
  const nombres = [...new Set(c.agentes.flatMap((a) => a.skills)), ...Array.from({ length: 800 }, (_, i) => `extra-${i}`)];
  let lecturas = 0;
  const inventario = inventarioConCache(() => { lecturas++; return nombres.map((name) => ({ name, description: name, instaladaEn: ['codex'], enAlmacen: [] })); }, 60_000);
  const medidas = [];
  for (const [caso, texto] of [['coincide', 'Analiza grafos usando pdf'], ['sin-coincidencia', 'Renombra esta variable']]) {
    const tiempos = [];
    for (let i = 0; i < 2000; i++) { const inicio = performance.now(); elegirEspecialista(texto, 'codex', inventario.leer(), c); tiempos.push(performance.now() - inicio); }
    tiempos.sort((a, b) => a - b);
    medidas.push({ caso, iteraciones: tiempos.length, p50_ms: tiempos[1000], p95_ms: tiempos[1900] });
  }
  console.log(JSON.stringify({ especialistas: c.agentes.length, skills: nombres.length, lecturas_inventario: lecturas, medidas }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
