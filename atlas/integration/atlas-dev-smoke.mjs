// Manual integration smoke against the locally built Atlas dev host.
// Usage: ATLAS_DEV_SERVER_ROOT=<atlas-dev/server> node atlas/integration/atlas-dev-smoke.mjs
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const host = process.env.ATLAS_DEV_SERVER_ROOT;
if (!host) throw new Error('Configura ATLAS_DEV_SERVER_ROOT con la carpeta server de Atlas dev');
const requireHost = createRequire(join(resolve(host), 'package.json'));
const Fastify = requireHost('fastify');
const { Paquetes } = requireHost('./dist/paquetes/paquetes.js');
const { empaquetar } = requireHost('./dist/paquetes/empaquetar.js');
const { registrarPaquetes } = requireHost('./dist/paquetes/rutas.js');
const { registrarKarajan } = requireHost('./dist/karajan/rutas.js');
const requireKarajan = createRequire(join(root, 'atlas/package.json'));
const { build } = requireKarajan('esbuild');

const temp = mkdtempSync(join(tmpdir(), 'karajan-atlas-host-'));
const workspace = join(temp, 'workspace');
const data = join(temp, 'atlas-data');
const source = join(temp, 'package-source');
mkdirSync(workspace, { recursive: true });
mkdirSync(join(source, 'dist-atlas'), { recursive: true });
process.env.ATLAS_WORKSPACE = workspace;
process.env.ATLAS_DEV_DATA = data;
process.env.ATLAS_KARAJAN_COMPARTIR = '0';
delete process.env.ATLAS_KARAJAN_DATA;
delete process.env.ATLAS_KARAJAN_LAYOUT;
delete process.env.ATLAS_KARAJAN_RESOURCES;
globalThis.fetch = async () => { throw new Error('Acceso de red prohibido durante la prueba'); };

const paquetes = new Paquetes({ dir: data });
const app = Fastify();
try {
  copyFileSync(join(root, 'atlas-package.json'), join(source, 'atlas-package.json'));
  for (const file of ['ui.js', 'ui.css']) {
    const actual = join(root, 'dist-atlas', file);
    if (!existsSync(actual)) throw new Error(`Falta ${actual}; construye primero el paquete de Atlas`);
    copyFileSync(actual, join(source, 'dist-atlas', file));
  }
  await build({ entryPoints: [join(root, 'atlas/src/servidor.ts')], outfile: join(source, 'dist-atlas/server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const { archivo } = empaquetar(source, { construir: false, salida: join(temp, 'salida') });
  const instalado = await paquetes.instalar(readFileSync(archivo));
  assert.equal(instalado.estado, 'activo', JSON.stringify(instalado));
  registrarPaquetes(app, paquetes);
  registrarKarajan(app, { base: 'http://127.0.0.1:9', paquetes });
  await app.ready();
  const health = await app.inject({ url: '/paquetes/karajan/api/health' });
  assert.equal(health.statusCode, 200, health.body);
  const resumen = await app.inject({ url: '/karajan/resumen?dias=30' });
  assert.equal(resumen.statusCode, 200, resumen.body);
  assert.equal(resumen.json().conectado, true, resumen.body);
  const ui = await app.inject({ url: '/paquetes/karajan/ui.js' });
  assert.equal(ui.statusCode, 200);
  assert.ok(ui.body.length > 0);
  const css = await app.inject({ url: '/paquetes/karajan/ui.css' });
  assert.equal(css.statusCode, 200);
  const layoutPath = join(data, 'paquetes-datos', 'karajan', 'routing_layout.json');
  const layoutBefore = existsSync(layoutPath) ? readFileSync(layoutPath, 'utf8') : null;
  const blocked = await app.inject({ method: 'PUT', url: '/paquetes/karajan/api/routing-layout', payload: {} });
  assert.equal(blocked.statusCode, 423, blocked.body);
  assert.equal(existsSync(layoutPath) ? readFileSync(layoutPath, 'utf8') : null, layoutBefore);
  assert.ok(existsSync(join(data, 'paquetes-datos', 'karajan', 'task_logs.db')));
  await paquetes.habilitar('karajan', false);
  assert.equal((await app.inject({ url: '/paquetes/karajan/api/health' })).statusCode, 404);
  console.log('Atlas dev: paquete temporal, health, puente, UI, bloqueo de producción y deshabilitación OK');
} finally {
  await app.close();
  await paquetes.cerrar();
  rmSync(temp, { recursive: true, force: true });
}
