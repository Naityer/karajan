import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { construirAnaliticaSkills } from './analitica';
import { Almacen } from './almacen';
import { listarSkills } from './catalogo';
import { clasificar, configDesde } from './heuristica';

/**
 * Karajan como paquete de Atlas dev: su núcleo de lectura y clasificación, en TypeScript y dentro del proceso de Atlas dev.
 * Atlas dev llama a `registrar(app, { id, version, datos })` con una instancia de Fastify propia y le reenvía
 * `/paquetes/karajan/api/*` SIN ese prefijo. Las rutas y las formas de respuesta son las de la API de Karajan (FastAPI), de modo
 * que lo que ya habla con ella (el puente `/karajan` de Atlas dev y sus widgets) funciona igual contra el paquete.
 *
 * Qué hay: `/health`, `/metrics`, `/agents/performance`, `/analytics/skills`, `/tasks` (+ detalle, runs y decisiones),
 * `/search/tasks`, `/skills`, `/config` y `/classify-task` (heurístico, sin persistir). Qué no (ver PORTE.md): delegar y
 * ejecutar con proveedores, el recomendador y la biblioteca de recursos, el scheduler y el SSE: responden 501.
 *
 * Datos: `<datos>/task_logs.db` y `<datos>/active_config.json`. Si no existen y `ATLAS_KARAJAN_DATA` apunta a la carpeta
 * `data/` de un Karajan, se copian al arrancar (copia: el Karajan nativo y Atlas dev no comparten fichero).
 */
const NO_DISPONIBLE = 'No disponible en el paquete de Atlas dev: necesita proveedores o la biblioteca de recursos (ver PORTE.md).';

interface Contexto { id: string; version: string; datos: string }
interface AppMinima {
  get(ruta: string, fn: (req: { query: Record<string, string | undefined>; params: Record<string, string> }) => unknown): void;
  post(ruta: string, fn: (req: { body: unknown }) => unknown): void;
  setErrorHandler(fn: (e: Error & { status?: number; statusCode?: number }, req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => unknown): void;
}

function importarDatos(datos: string): boolean {
  const origen = process.env['ATLAS_KARAJAN_DATA'];
  const destino = join(datos, 'task_logs.db');
  if (!origen || existsSync(destino) || !existsSync(join(origen, 'task_logs.db'))) return false;
  mkdirSync(datos, { recursive: true });
  for (const f of ['task_logs.db', 'task_logs.db-wal', 'task_logs.db-shm', 'active_config.json']) {
    if (existsSync(join(origen, f)) && !existsSync(join(datos, f))) copyFileSync(join(origen, f), join(datos, f));
  }
  return true;
}

const entero = (v: string | undefined, defecto: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, Math.trunc(n))) : defecto;
};
const falla = (estado: number, detail: string) => Object.assign(new Error(detail), { status: estado });

export async function registrar(app: AppMinima, ctx: Contexto): Promise<void> {
  const importada = importarDatos(ctx.datos);
  mkdirSync(ctx.datos, { recursive: true });
  const almacen = new Almacen(join(ctx.datos, 'task_logs.db'));
  const config = () => {
    try { return configDesde(JSON.parse(readFileSync(join(ctx.datos, 'active_config.json'), 'utf8'))); } catch { return configDesde(null); }
  };

  app.setErrorHandler((e, _req, reply) => reply.code(e.status ?? e.statusCode ?? 500).send({ detail: e.message || 'Error interno' }));

  app.get('/health', () => ({ status: 'ok', paquete: ctx.id, version: ctx.version, importada, tareas: almacen.contar() }));
  app.get('/metrics', () => almacen.metricas());
  app.get('/agents/performance', () => almacen.rendimientoAgentes());

  app.get('/analytics/skills', (req) => {
    const dias = entero(req.query['days'], 30, 0, 3650);
    const registros = almacen.listarTareas();
    const runsPorTarea = Object.fromEntries(registros.filter((r) => r.delegation).map((r) => [r.task_id, almacen.runs(r.task_id)]));
    return construirAnaliticaSkills(registros, { runsPorTarea, skillsConocidas: listarSkills().map((s) => s.name), dias });
  });

  app.get('/tasks', (req) => almacen.listarTareas(entero(req.query['limit'], 50, 1, 500), entero(req.query['offset'], 0, 0, 1_000_000)).map((t) => ({
    task_id: t.task_id, prompt: t.prompt, status: t.status, created_at: t.created_at, updated_at: t.updated_at, classification: t.classification, delegation: t.delegation,
  })));
  app.get('/tasks/:id', (req) => { const t = almacen.tarea(req.params['id']!); if (!t) throw falla(404, 'Tarea no encontrada'); return t; });
  app.get('/tasks/:id/runs', (req) => almacen.runs(req.params['id']!));
  app.get('/tasks/:id/decisions', (req) => almacen.decisiones(req.params['id']!));
  app.get('/search/tasks', (req) => {
    const q = req.query['q'] ?? '';
    const resultados = almacen.buscar(q, entero(req.query['limit'], 20, 1, 100));
    return { query: q, count: resultados.length, results: resultados };
  });
  app.get('/skills', () => listarSkills());
  app.get('/config', () => config());

  // Clasificación heurística (la misma que usa Karajan sin LLM). No se guarda: persistir tareas es del Karajan completo.
  app.post('/classify-task', (req) => {
    const prompt = typeof (req.body as { prompt?: unknown } | null)?.prompt === 'string' ? ((req.body as { prompt: string }).prompt).trim() : '';
    if (!prompt) throw falla(422, 'prompt cannot be blank');
    if (prompt.length > 20_000) throw falla(422, 'prompt demasiado largo (máx. 20000 caracteres)');
    return clasificar(prompt, config());
  });

  for (const [metodo, ruta] of [['post', '/resources/recommend'], ['post', '/resources/ingest-url'], ['post', '/delegate-task'], ['post', '/executions'], ['post', '/ingest']] as const) {
    app[metodo](ruta, () => { throw falla(501, NO_DISPONIBLE); });
  }
}
