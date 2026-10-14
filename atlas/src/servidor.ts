import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { construirAnaliticaSkills } from './analitica';
import { Almacen } from './almacen';
import { catalogoReal, listarSkills } from './catalogo';
import { produccion } from './produccion';
import { Delegador } from './delegar';
import { clasificar, configDesde } from './heuristica';
import { ErrorPerfil, Perfiles } from './perfiles';
import { disponibilidad, PROVEEDORES } from './proveedores';

/**
 * Karajan como paquete de Atlas dev: su núcleo de lectura y clasificación, en TypeScript y dentro del proceso de Atlas dev.
 * Atlas dev llama a `registrar(app, { id, version, datos })` con una instancia de Fastify propia y le reenvía
 * `/paquetes/karajan/api/*` SIN ese prefijo. Las rutas y las formas de respuesta son las de la API de Karajan (FastAPI), de modo
 * que lo que ya habla con ella (el puente `/karajan` de Atlas dev y sus widgets) funciona igual contra el paquete.
 *
 * Qué hay: `/health`, `/metrics`, `/agents/performance`, `/analytics/skills`, `/tasks` (+ detalle, runs y decisiones),
 * `/search/tasks`, `/skills`, `/config`, `/classify-task` (heurístico, sin persistir), los perfiles (`/routing-layout`, compartido
 * con el Karajan nativo), `/providers`, `/routing/plan` (a quién iría cada subtarea, sin ejecutar) y `/delegate-task`, que
 * ejecuta de verdad Claude Code, Codex o Qwen (ollama) según las reglas del perfil por defecto. Qué no (ver PORTE.md): el
 * recomendador y la biblioteca de recursos, el scheduler en modo cola y el SSE: responden 501.
 *
 * Datos: con un Karajan nativo en el Workspace (`ATLAS_KARAJAN_DATA` o `<ATLAS_WORKSPACE>/karajan/data`) se COMPARTEN su
 * `task_logs.db`, su `active_config.json` y sus perfiles, para que las gráficas de Atlas dev y las del dashboard nativo
 * cuenten lo mismo (ver `datosKarajan`). Sin él, o con `ATLAS_KARAJAN_COMPARTIR=0`, se usan `<datos>/task_logs.db` y
 * `<datos>/routing_layout.json` (copiando antes el registro de `ATLAS_KARAJAN_DATA` si lo hay). Las carpetas de trabajo de `/delegate-task` deben estar dentro de
 * `ATLAS_WORKSPACE` (o de la carpeta de usuario).
 */
const NO_DISPONIBLE = 'No disponible en el paquete de Atlas dev: necesita proveedores o la biblioteca de recursos (ver PORTE.md).';

interface Contexto { id: string; version: string; datos: string }
interface AppMinima {
  get(ruta: string, fn: (req: { query: Record<string, string | undefined>; params: Record<string, string> }) => unknown): void;
  post(ruta: string, fn: (req: { body: unknown; params: Record<string, string> }, reply: { code(n: number): unknown }) => unknown): void;
  put(ruta: string, fn: (req: { body: unknown }) => unknown): void;
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

/**
 * La carpeta `data/` del Karajan nativo, si la hay: `ATLAS_KARAJAN_DATA`, o `<ATLAS_WORKSPACE>/karajan/data`. Con ella el
 * paquete y el Karajan nativo comparten registro de tareas y perfiles (SQLite en WAL admite los dos procesos), así las
 * gráficas de Atlas dev y las del dashboard nativo cuentan lo mismo. `ATLAS_KARAJAN_COMPARTIR=0` vuelve a la copia propia.
 */
function datosKarajan(): string | null {
  const explicita = process.env['ATLAS_KARAJAN_DATA'];
  if (explicita) return existsSync(explicita) ? explicita : null;
  const ws = process.env['ATLAS_WORKSPACE'];
  return ws && existsSync(join(ws, 'karajan', 'data', 'task_logs.db')) ? join(ws, 'karajan', 'data') : null;
}

export async function registrar(app: AppMinima, ctx: Contexto): Promise<void> {
  const nativo = datosKarajan();
  const compartida = nativo !== null && process.env['ATLAS_KARAJAN_COMPARTIR'] !== '0' && existsSync(join(nativo, 'task_logs.db'));
  const importada = compartida ? false : importarDatos(ctx.datos);
  mkdirSync(ctx.datos, { recursive: true });
  const dirDatos = compartida ? nativo! : ctx.datos;
  const almacen = new Almacen(join(dirDatos, 'task_logs.db'));
  const config = () => {
    try { return configDesde(JSON.parse(readFileSync(join(dirDatos, 'active_config.json'), 'utf8'))); } catch { return configDesde(null); }
  };

  const rutaLayout = process.env['ATLAS_KARAJAN_LAYOUT'] ?? (nativo ? join(nativo, 'routing_layout.json') : join(ctx.datos, 'routing_layout.json'));
  const perfiles = new Perfiles(rutaLayout);
  const delegador = new Delegador({ almacen, perfiles, config, raiz: process.env['ATLAS_WORKSPACE'] ?? homedir() });

  app.setErrorHandler((e, _req, reply) => reply.code(e.status ?? e.statusCode ?? 500).send({ detail: e.message || 'Error interno' }));

  app.get('/health', () => ({ status: 'ok', paquete: ctx.id, version: ctx.version, importada, compartida, tareas: almacen.contar() }));
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

  // ── Perfiles y reglas (compartidos con el Karajan nativo) ─────────────────
  const conPerfil = <T,>(fn: () => T): T => { try { return fn(); } catch (e) { if (e instanceof ErrorPerfil) throw falla(422, e.message); throw e; } };
  app.get('/routing-layout', () => ({ ...perfiles.leer(), path: rutaLayout }));
  app.put('/routing-layout', (req) => conPerfil(() => perfiles.guardar(req.body)));
  app.post('/routing-layout/presets/dominios', (req) => conPerfil(() => perfiles.aplicarPresetDominio({ porDefecto: (req.body as { por_defecto?: unknown } | null)?.por_defecto !== false })));
  app.post('/routing-layout/presets/nivel', (req) => conPerfil(() => perfiles.aplicarPresetNivel({ porDefecto: (req.body as { por_defecto?: unknown } | null)?.por_defecto !== false })));
  // Configurar un perfil con una frase: sin `aplicar` solo devuelve la propuesta (perfil y cambios).
  app.post('/routing-layout/desde-texto', (req) => conPerfil(() => {
    const b = (req.body ?? {}) as { texto?: unknown; perfil_id?: unknown; aplicar?: unknown };
    const texto = typeof b.texto === 'string' ? b.texto.trim().slice(0, 2000) : '';
    if (!texto) throw falla(422, 'Escribe cómo quieres el perfil');
    return perfiles.desdeTexto(texto, { perfilId: typeof b.perfil_id === 'string' ? b.perfil_id : undefined, aplicar: b.aplicar === true });
  }));

  // ── Proveedores y delegación real ────────────────────────────────────────
  app.get('/providers', () => PROVEEDORES.map((p) => disponibilidad(p)));
  const leerPrompt = (body: unknown) => {
    const prompt = typeof (body as { prompt?: unknown } | null)?.prompt === 'string' ? ((body as { prompt: string }).prompt).trim() : '';
    if (!prompt) throw falla(422, 'prompt cannot be blank');
    if (prompt.length > 20_000) throw falla(422, 'prompt demasiado largo (máx. 20000 caracteres)');
    return prompt;
  };
  app.post('/routing/plan', (req) => {
    const b = (req.body ?? {}) as { force_entity_id?: unknown };
    return delegador.planificar(leerPrompt(req.body), typeof b.force_entity_id === 'string' ? b.force_entity_id : null);
  });
  app.post('/delegate-task', (req, reply) => {
    const b = (req.body ?? {}) as { force_entity_id?: unknown; cwd?: unknown; human_approved?: unknown; entry_agent?: unknown };
    const plan = delegador.delegar(leerPrompt(req.body), { forzarEntidad: typeof b.force_entity_id === 'string' ? b.force_entity_id : null, cwd: b.cwd, aprobada: b.human_approved === true, entrada: typeof b.entry_agent === 'string' ? b.entry_agent : null });
    reply.code(plan.bloqueada ? 200 : 202);
    return plan;
  });

  // ── Producción: acierto, flujo, eficiencia, matriz de skills y «qué mejorar» (port de app/analytics/produccion.py) ──
  // `perfil=activo` (por defecto) deja solo los agentes del perfil por defecto; `todos`, el histórico completo.
  const calcular = (q: Record<string, string | undefined>) => {
    const dias = entero(q['dias'], 0, 0, 3650);
    let agentes: string[] | null = null;
    let noDisponibles: string[] = [];
    if (q['perfil'] !== 'todos') {
      const layout = perfiles.leer() as { default_profile_id?: string; profiles?: { id: string; entities?: { provider?: string | null }[] }[] };
      const p = layout.profiles?.find((x) => x.id === layout.default_profile_id);
      agentes = [...new Set((p?.entities ?? []).map((e) => e.provider).filter((x): x is string => !!x))].sort();
      const estado = new Map(PROVEEDORES.map((pr) => [pr.nombre, disponibilidad(pr).disponible] as const));
      noDisponibles = agentes.filter((a) => estado.has(a) && !estado.get(a));
    }
    return produccion(almacen.tareasPlanas(), { catalogo: catalogoReal(), agentesPerfil: agentes, dias, ahora: new Date(), noDisponibles });
  };
  const cabecera = (p: ReturnType<typeof calcular>) => ({ dias: p.dias, perfil: p.perfil, agentes_perfil: p.agentes_perfil, ultima: p.ultima, kpis: p.kpis });
  app.get('/analytics/produccion', (req) => { const { acierto: _a, ...p } = calcular(req.query); return p; });
  app.get('/analytics/flujo', (req) => { const p = calcular(req.query); return { ...cabecera(p), ...p.flujo }; });
  app.get('/analytics/eficiencia', (req) => { const p = calcular(req.query); return { ...cabecera(p), ...p.eficiencia }; });
  app.get('/analytics/matriz-skills', (req) => { const p = calcular(req.query); return { ...cabecera(p), ...p.matriz }; });
  app.get('/analytics/sugerencias', (req) => { const p = calcular(req.query); return { ...cabecera(p), sugerencias: p.sugerencias }; });
  app.get('/analytics/acierto', (req) => { const p = calcular(req.query); return { ...cabecera(p), tareas: p.acierto }; });
  app.get('/skills/catalogo', (req) => { const p = calcular({ dias: req.query['dias'] ?? '90', perfil: 'todos' }); return { dias: p.dias, ...p.catalogo }; });

  // Lo revisado por el usuario en la cabecera de agente de las notas del baúl (lo envía Atlas dev al reindexar).
  const CAMPOS_REVISION = new Set(['agente_entrada', 'agente', 'skills_usadas', 'categoria_skill', 'nivel_tarea', 'dominio', 'intencion', 'palabras_clave']);
  app.post('/feedback/revisiones', (req) => {
    const lista = (req.body as { revisiones?: unknown } | null)?.revisiones;
    if (!Array.isArray(lista) || lista.length > 5000) throw falla(422, 'revisiones: lista de hasta 5000 {task_id, campos}');
    let guardadas = 0;
    for (const r of lista as { task_id?: unknown; campos?: unknown; revisado_en?: unknown }[]) {
      if (typeof r?.task_id !== 'string' || !r.task_id || r.task_id.length > 80) continue;
      const campos: Record<string, string[]> = {};
      for (const [k, vs] of Object.entries((r.campos ?? {}) as Record<string, unknown>)) {
        if (CAMPOS_REVISION.has(k) && Array.isArray(vs)) campos[k] = vs.slice(0, 50).map((v) => String(v).slice(0, 120));
      }
      almacen.guardarRevision(r.task_id, campos, typeof r.revisado_en === 'string' ? r.revisado_en : new Date().toISOString());
      guardadas++;
    }
    return { guardadas };
  });

  for (const [metodo, ruta] of [['post', '/resources/recommend'], ['post', '/resources/ingest-url'], ['post', '/executions'], ['post', '/ingest']] as const) {
    app[metodo](ruta, () => { throw falla(501, NO_DISPONIBLE); });
  }
}
