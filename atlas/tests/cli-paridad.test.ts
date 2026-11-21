import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import paquete from '../../atlas-package.json';
import { ejecutar } from '../src/cli';
import { registrar } from '../src/servidor';

// Utiliza los manejadores reales registrados por el paquete y los mismos datos
// temporales para ambos transportes, sin abrir puertos ni contactar con Atlas.
it('CLI local y rutas del paquete conservan los contratos de lectura', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-paridad-'));
  const datos = join(dir, 'datos'); mkdirSync(datos);
  const entorno = ['ATLAS_WORKSPACE', 'ATLAS_KARAJAN_DATA', 'ATLAS_KARAJAN_LAYOUT', 'ATLAS_KARAJAN_RESOURCES', 'ATLAS_DEV_API'] as const;
  const previo = Object.fromEntries(entorno.map((k) => [k, process.env[k]]));
  process.env['ATLAS_WORKSPACE'] = dir;
  for (const k of entorno.slice(1)) delete process.env[k];
  writeFileSync(join(datos, 'modo.json'), '{"modo":"desarrollo"}');
  writeFileSync(join(datos, 'dosificador.json'), '{}');
  writeFileSync(join(datos, 'active_config.json'), '{}');
  copyFileSync(join(import.meta.dirname, 'fixtures', 'tareas.db'), join(datos, 'task_logs.db'));
  const recursos = new DatabaseSync(join(datos, 'resources.db'));
  recursos.exec(`
    CREATE TABLE resources (id TEXT PRIMARY KEY, slug TEXT, name TEXT, kind TEXT, source TEXT, repo_url TEXT, summary TEXT, tags_json TEXT, requirements_json TEXT, capabilities_json TEXT, compatible_runtimes_json TEXT, install_strategy TEXT, status TEXT, installations_json TEXT, visible_agent_ids_json TEXT, metadata_json TEXT, created_at TEXT, updated_at TEXT, parent_resource_id TEXT, source_url TEXT, indexed_at TEXT, index_status TEXT);
    CREATE TABLE resource_groups (id TEXT PRIMARY KEY, name TEXT, description TEXT, parent_id TEXT, sort_order INTEGER, created_at TEXT, updated_at TEXT);
    CREATE TABLE resource_group_assignments (resource_id TEXT PRIMARY KEY, group_id TEXT);
    CREATE TABLE resource_operations (operation_id TEXT PRIMARY KEY, resource_id TEXT, action TEXT, status TEXT, detail TEXT, targets_json TEXT, metadata_json TEXT, created_at TEXT);
    CREATE TABLE resource_preferences (preference_key TEXT PRIMARY KEY, value_json TEXT, updated_at TEXT);
    CREATE TABLE discovery_sources (id TEXT PRIMARY KEY, name TEXT, url TEXT, provider TEXT, source_type TEXT, description TEXT, enabled INTEGER, available INTEGER, requires_credentials INTEGER, setup_hint TEXT, metadata_json TEXT, created_at TEXT, updated_at TEXT);
    INSERT INTO resources VALUES ('r1','ponytail','ponytail','skill','github','https://github.com/x/ponytail','Mínimo código','["codigo"]','[]','[]','["claude"]','manual','available','[]','[]','{"validity":{"state":"pending_review"}}','','',NULL,NULL,NULL,'active');
    INSERT INTO resource_groups VALUES ('g1','Eficiencia','',NULL,0,'','');
    INSERT INTO resource_group_assignments VALUES ('r1','g1');
    INSERT INTO resource_preferences VALUES ('artifact_validity_policy','{"min_github_stars":500}','');
  `);
  recursos.close();
  writeFileSync(join(datos, 'routing_layout.json'), JSON.stringify({ profiles: [
    { id: 'primero', name: 'Primero', entities: [] }, { id: 'segundo', name: 'Segundo', entities: [] },
  ], active_profile_id: 'primero', default_profile_id: 'segundo' }));

  type Handler = (req: any, reply: any) => unknown;
  const rutas = new Map<string, Handler>();
  let cerrar = async () => {};
  let errores: Handler = () => {};
  const app = {
    get: (ruta: string, fn: Handler) => rutas.set(`GET ${ruta}`, fn),
    post: (ruta: string, fn: Handler) => rutas.set(`POST ${ruta}`, fn),
    put: (ruta: string, fn: Handler) => rutas.set(`PUT ${ruta}`, fn),
    addHook: (_: string, fn: () => Promise<void>) => { cerrar = fn; },
    setErrorHandler: (fn: Handler) => { errores = fn; },
  };
  try {
    await registrar(app as never, { id: 'karajan', version: paquete.version, datos });
    const fetchPaquete = async (url: string, init?: { method?: string; body?: string }) => {
      const uri = new URL(url); const ruta = uri.pathname;
      const metodo = init?.method ?? 'GET';
      const dinamica = /^\/(resources|tasks)\/([^/]+)(\/runs|\/decisions)?$/.exec(ruta);
      const handler = rutas.get(`${metodo} ${ruta}`) ?? (dinamica ? rutas.get(`${metodo} /${dinamica[1]}/:id${dinamica[3] ?? ''}`) : undefined);
      if (!handler) return { ok: false, status: 404, json: async () => ({ detail: `Sin ruta ${ruta}` }) };
      let status = 200; let contenido: unknown;
      const reply = { code: (n: number) => { status = n; return { send: (v: unknown) => { contenido = v; } }; } };
      try { contenido = await handler({ query: Object.fromEntries(uri.searchParams), params: dinamica ? { id: decodeURIComponent(dinamica[2]!) } : {}, headers: {}, body: init?.body ? JSON.parse(init.body) : null }, reply); }
      catch (err) { errores(err, null, reply); }
      return { ok: status < 400, status, json: async () => contenido };
    };
    const comparar = async (args: string[], locales: string[]) => {
      for (const json of [false, true]) {
        const opciones = json ? ['--json'] : [];
        let salidaLocal = '', salidaHttp = '';
        const leer = (p: string) => readFileSync(p, 'utf8');
        const local = await ejecutar([...args, ...locales, '--local', ...opciones], { api: 'http://paquete', fetch: async () => { throw new Error('la operación local usó la red'); }, leer, escribir: (s) => { salidaLocal = s; } });
        const http = await ejecutar([...args, '--http', ...opciones], { api: 'http://paquete', fetch: fetchPaquete, leer, escribir: (s) => { salidaHttp = s; } });
        assert.equal(local, http, args.join(' '));
        assert.equal(salidaLocal, salidaHttp, `${args.join(' ')} ${json ? 'JSON' : 'texto'}`);
      }
    };
    const db = join(datos, 'task_logs.db'), lab = join(datos, 'laboratorio', 'laboratorio.db');
    const layout = join(datos, 'routing_layout.json');
    for (const args of [['modo'], ['componentes'], ['lab', 'ls'], ['lab', 'informe', 'dosificador'], ['lab', 'historial', 'dosificador', 'total']])
      await comparar(args, ['--datos', datos, '--lab-db', lab]);
    for (const args of [['control', 'perfiles'], ['control', 'jerarquia'], ['control', 'jerarquia', '--perfil', 'primero']])
      await comparar(args, ['--layout', layout]);
    for (const args of [['estadisticas', 'tareas'], ['estadisticas', 'resumen', '--perfil', 'todos'], ['estadisticas', 'resumen', '--perfil', 'activo'], ['grafica', 'flujo', '--perfil', 'todos'], ['grafica', 'flujo', '--perfil', 'activo'], ['grafica', 'eficiencia', '--perfil', 'todos'], ['grafica', 'matriz-skills', '--perfil', 'todos']])
      await comparar(args, ['--tasks-db', db, '--layout', layout]);
    await comparar(['dosificador', 'config'], ['--config', join(datos, 'dosificador.json')]);
    await comparar(['dosificador', 'simular', '--semanas', '1', '--semilla', '42'], ['--config', join(datos, 'dosificador.json')]);
    for (const args of [['inspiration', 'resumen'], ['inspiration', 'lista'], ['inspiration', 'lista', '--buscar', 'PONY'], ['inspiration', 'grupos'], ['inspiration', 'arbol'], ['inspiration', 'ver', 'ponytail'], ['inspiration', 'radar'], ['inspiration', 'revision'], ['inspiration', 'validez'], ['comparar', 'ponytail']])
      await comparar(args, ['--resources-db', join(datos, 'resources.db')]);
    // Los contratos históricos usan salida de error local (código 2) frente a
    // excepción HTTP (convertida en código 1 por el programa principal).
    const invalida = join(datos, 'entrada-invalida.json');
    const estado = join(datos, 'dosificador-estado.json');
    writeFileSync(invalida, '{}'); writeFileSync(estado, '{}');
    const leer = (p: string) => readFileSync(p, 'utf8');
    let errorLocal = '';
    assert.equal(await ejecutar(['dosificador', 'decidir', '--entrada', invalida, '--config', join(datos, 'dosificador.json'), '--estado', estado, '--local'], { api: 'http://paquete', fetch: async () => { throw new Error('red'); }, leer, escribir: (s) => { errorLocal = s; } }), 2);
    assert.ok(errorLocal.length > 0);
    await assert.rejects(ejecutar(['dosificador', 'decidir', '--entrada', invalida, '--http'], { api: 'http://paquete', fetch: fetchPaquete, leer, escribir: () => {} }), /400: (?!error$).+/);
  } finally {
    await cerrar();
    for (const [k, v] of Object.entries(previo)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(dir, { recursive: true, force: true });
  }
});

it('CLI conserva el error HTTP del dosificador y envía la tarea solicitada', async () => {
  let cabeceras: Record<string, string> | undefined;
  const fetch = async (_url: string, init?: { headers?: Record<string, string> }) => {
    cabeceras = init?.headers;
    return { ok: false, status: 400, json: async () => ({ error: 'entrada inválida' }) };
  };
  await assert.rejects(ejecutar(['dosificador', 'config', '--http', '--set', '{}', '--tarea', 'tsk-1'], { api: 'http://paquete', fetch, escribir: () => {} }), /400: entrada inválida/);
  assert.equal(cabeceras?.['x-karajan-tarea'], 'tsk-1');
});
