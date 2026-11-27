import { listarSkills } from './catalogo';
import { crearAplicacion } from './aplicacion';
import { crearAplicacionDosificador } from './aplicacion-dosificador';
import { crearAplicacionPlanificador } from './aplicacion-planificador';
import { crearAplicacionLaboratorio } from './aplicacion-laboratorio';
import { disponibilidad, PROVEEDORES } from './proveedores';
import { crearRuntime } from './runtime';
import { consultarTareas } from './almacen';
import { consultarBiblioteca } from './biblioteca';
import { ErrorServicio, ServicioAnalisis } from './analisis/servicio';

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
 * Datos: el paquete usa sus propias bases y configuración en `ctx.datos`. En la primera ejecución importa una instantánea
 * de la base nativa detectada o indicada en `ATLAS_KARAJAN_DATA`, sin sobrescribir una base de destino existente. La biblioteca
 * configurada explícitamente también se importa una vez. Las carpetas de trabajo de `/delegate-task` deben estar dentro de
 * `ATLAS_WORKSPACE` (o de la carpeta de usuario). Esto no aísla el proceso ni restringe sus permisos de sistema operativo.
 */
const NO_DISPONIBLE = 'No disponible en el paquete de Atlas dev: necesita proveedores o la biblioteca de recursos (ver PORTE.md).';

interface Contexto { id: string; version: string; datos: string }
type Cabeceras = Record<string, string | string[] | undefined>;
interface AppMinima {
  addHook?(nombre: 'onClose', fn: () => Promise<void>): void;
  get(ruta: string, fn: (req: { query: Record<string, string | undefined>; params: Record<string, string> }) => unknown): void;
  post(ruta: string, fn: (req: { body: unknown; params: Record<string, string>; headers: Cabeceras }, reply: { code(n: number): unknown }) => unknown): void;
  put(ruta: string, fn: (req: { body: unknown; headers: Cabeceras }) => unknown): void;
  setErrorHandler(fn: (e: Error & { status?: number; statusCode?: number; extra?: Record<string, unknown> }, req: unknown, reply: { code(n: number): { send(b: unknown): unknown } }) => unknown): void;
}

const falla = (estado: number, detail: string) => Object.assign(new Error(detail), { status: estado });

export async function registrar(app: AppMinima, ctx: Contexto): Promise<void> {
  const runtime = crearRuntime(ctx.datos, { datosPropios: true });
  const aplicacion = crearAplicacion(runtime);
  const { compartida, importada, almacen, config, mutar, biblioteca, atlasDev, pasarela, guardian } = runtime;
  app.addHook?.('onClose', async () => { runtime.cerrar(); });

  app.setErrorHandler((e, _req, reply) => reply.code(e.status ?? e.statusCode ?? 500).send({ detail: e.message || 'Error interno', ...(e.extra ?? {}) }));

  // ── Dosificador: cuándo, dónde y con qué agente se lanza cada tarea (ver dosificador.ts y docs/laboratorio/componentes.md) ──
  // Config y estado van en <datos>/dosificador.json y dosificador-estado.json. `decidir` solo DECIDE: no lanza ni cambia nada fuera de
  // su propio estado (histéresis, estimador, circuitos y leases); cambiar la configuración sí exige tarea aceptada en producción.
  const dosificador = crearAplicacionDosificador(ctx.datos, mutar);
  // Los errores de entrada históricos son HTTP 400 con {error}, no {detail}.
  const respuestaDos = (resultado: object, reply: { code(n: number): unknown }) => {
    if ('error' in resultado) reply.code(400);
    return resultado;
  };
  app.post('/dosificador/decidir', (req, reply) => respuestaDos(dosificador.tomarDecision(req.body), reply));
  app.post('/dosificador/observar', (req, reply) => respuestaDos(dosificador.observar(req.body), reply));
  app.get('/dosificador/estado', () => dosificador.estado());
  app.post('/dosificador/relevo', (req, reply) => respuestaDos(dosificador.relevo(req.body), reply));
  app.get('/dosificador/decisiones', () => dosificador.decisiones());
  app.get('/dosificador/config', () => dosificador.consultarConfig());
  app.put('/dosificador/config', (req) => dosificador.cambiarConfig(req));
  app.post('/dosificador/simular', (req) => dosificador.simular(req.body));

  // ── Planificador: el plan de cada tarea (modo, actores, pasos, hitos, checker). Solo DECIDE y registra: lo ejecuta la cola de Atlas dev ──
  const planificador = crearAplicacionPlanificador(runtime, dosificador);
  // Siempre 200: una combinación imposible vuelve como plan rechazado (`plan.errores`, sin pasos), con el cuerpo íntegro para quien lo pinta.
  app.post('/planificador/plan', (req) => planificador.crearPlan(req.body));
  app.post('/planificador/validar', (req) => planificador.validar(req.body));
  app.get('/planificador/modos', () => planificador.modos());
  app.get('/planificador/config', () => planificador.consultarConfig());
  app.put('/planificador/config', (req) => planificador.cambiarConfig(req));
  app.get('/planificador/planes', () => planificador.planes());
  app.get('/planificador/planes/:tarea', (req) => planificador.plan(req.params['tarea']!));
  app.post('/planificador/evento', (req) => planificador.evento(req.body));
  app.post('/planificador/checker', (req) => planificador.checker(req.body));

  // ── Análisis de tareas (hsr2): etiqueta y puntúa el histórico del registro de Atlas dev; ver docs/analisis-tareas.md ──
  // Escribe `analisis.json` junto a cada tarea del registro y nada más. Procesar es operativo (lo lanza la rutina de Atlas dev) y no
  // exige tarea aceptada; cambiar la configuración sí.
  const analisis = new ServicioAnalisis({ datos: ctx.datos, atlasDev, pasarela });
  const deAnalisis = async <T>(f: () => Promise<T> | T): Promise<T> => {
    try { return await f(); } catch (e) { throw e instanceof ErrorServicio ? falla(e.estado, e.message) : e; }
  };
  app.post('/analisis/procesar', (req) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return deAnalisis(() => analisis.procesar({
      ...(typeof b['limite'] === 'number' ? { limite: Math.min(1000, Math.max(1, Math.trunc(b['limite']))) } : {}), forzar: b['forzar'] === true, soloRegistro: b['solo_registro'] === true,
    }));
  });
  app.get('/analisis/estado', () => deAnalisis(() => analisis.estado()));
  app.get('/analisis/tarea/:id', (req) => deAnalisis(() => analisis.tarea(req.params['id']!)));
  app.get('/analisis/taxonomia', () => analisis.taxonomia());
  app.get('/analisis/export', () => deAnalisis(() => analisis.exportar()));
  app.post('/analisis/destilar', () => deAnalisis(() => analisis.destilar()));
  app.get('/analisis/config', () => ({ config: analisis.config(), fichero: analisis.rutaConfig }));
  app.put('/analisis/config', async (req) => {
    await guardian.exigir(req, 'PUT /analisis/config');
    const b = req.body;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw falla(422, 'config: un objeto con los campos a cambiar');
    const { tarea: _tarea, ...resto } = b as Record<string, unknown>;
    return { config: analisis.guardarConfig(resto['config'] && typeof resto['config'] === 'object' ? resto['config'] : resto), fichero: analisis.rutaConfig };
  });

  app.get('/health', () => ({ status: 'ok', paquete: ctx.id, version: ctx.version, importada, compartida, tareas: almacen.contar() }));
  app.get('/metrics', () => almacen.metricas());
  app.get('/agents/performance', () => almacen.rendimientoAgentes());

  app.get('/analytics/skills', (req) => aplicacion.analiticaSkills(req.query));

  app.get('/tasks', (req) => consultarTareas(almacen, '/tasks', req.query));
  app.get('/tasks/:id', (req) => consultarTareas(almacen, `/tasks/${encodeURIComponent(req.params['id']!)}`));
  app.get('/tasks/:id/runs', (req) => consultarTareas(almacen, `/tasks/${encodeURIComponent(req.params['id']!)}/runs`));
  app.get('/tasks/:id/decisions', (req) => consultarTareas(almacen, `/tasks/${encodeURIComponent(req.params['id']!)}/decisions`));
  app.get('/search/tasks', (req) => aplicacion.buscarTareas(req.query));
  app.get('/skills', () => listarSkills());
  app.get('/config', () => config());

  // Los adaptadores HTTP solo traducen peticiones y respuestas; las reglas viven en la aplicación.
  app.post('/classify-task', (req) => aplicacion.clasificar(req.body));
  app.get('/routing-layout', () => aplicacion.leerPerfil());
  app.put('/routing-layout', (req) => aplicacion.guardarPerfil(req));
  app.post('/routing-layout/presets/dominios', (req) => aplicacion.presetDominios(req));
  app.post('/routing-layout/presets/nivel', (req) => aplicacion.presetNivel(req));
  // Perfil base (puntuación continua por agente) y evolución de perfiles: la evolución solo PROPONE (hijos inactivos con linaje).
  app.post('/routing-layout/presets/base', (req) => aplicacion.presetBase(req));
  app.get('/routing-layout/evolucion/fitness', () => aplicacion.fitnessEvolucion());
  app.post('/routing-layout/evolucion/proponer', (req) => aplicacion.proponerEvolucion(req));
  app.post('/routing-layout/desde-texto', (req) => aplicacion.perfilDesdeTexto(req));
  app.get('/providers', () => PROVEEDORES.map((p) => disponibilidad(p)));
  app.post('/routing/plan', (req) => aplicacion.planificar(req.body));
  app.post('/delegate-task', (req, reply) => {
    const plan = aplicacion.delegar(req.body);
    reply.code(plan.bloqueada ? 200 : 202);
    return plan;
  });

  app.get('/especialistas/config', () => aplicacion.especialistasConfig());
  app.put('/especialistas/config', (req) => aplicacion.guardarEspecialistasConfig(req));
  app.get('/especialistas', () => aplicacion.listarEspecialistas());
  app.post('/especialistas/resolver', (req) => aplicacion.resolverEspecialista(req));

  // Analítica: el adaptador deja los cálculos a la aplicación compartida.
  app.get('/analytics/produccion', (req) => aplicacion.produccion(req.query));
  app.get('/analytics/flujo', (req) => aplicacion.flujo(req.query));
  app.get('/analytics/eficiencia', (req) => aplicacion.eficiencia(req.query));
  app.get('/analytics/matriz-skills', (req) => aplicacion.matrizSkills(req.query));
  app.get('/analytics/sugerencias', (req) => aplicacion.sugerencias(req.query));
  app.get('/analytics/acierto', (req) => aplicacion.acierto(req.query));
  app.get('/skills/catalogo', (req) => aplicacion.catalogoSkills(req.query));

  // ── Inspiration: la biblioteca de recursos en SOLO LECTURA (las altas, la revisión y el refresco son del Karajan nativo) ──
  for (const ruta of ['/resources', '/resources/index', '/resources/discovery/sources', '/resources/review', '/resources/validity-policy', '/resources/refresh/settings', '/resource-groups'])
    app.get(ruta, (req) => consultarBiblioteca(biblioteca, ruta, req.query));
  app.get('/resources/:id', (req) => consultarBiblioteca(biblioteca, `/resources/${encodeURIComponent(req.params['id']!)}`));

  // La aplicación centraliza la guarda al aplicar cambios.
  app.get('/skills/rotacion', () => aplicacion.consultarRotacion());
  app.post('/skills/rotar', (req) => aplicacion.rotar(req));

  app.post('/feedback/revisiones', (req) => aplicacion.guardarRevisiones(req.body));

  const laboratorio = crearAplicacionLaboratorio(runtime, ctx.version, dosificador, planificador);
  app.get('/laboratorio/componentes', laboratorio.componentes);
  app.get('/laboratorio/arquitectura', laboratorio.arquitectura);
  app.get('/laboratorio/arquitectura/:id', laboratorio.arquitecturaDetalle);
  app.get('/laboratorio/comparar', laboratorio.comparar);
  app.get('/laboratorio/ejecuciones', laboratorio.ejecuciones);
  app.get('/laboratorio/tutores', laboratorio.tutores);
  app.post('/laboratorio/tutores/actualizar', laboratorio.actualizar);
  app.get('/laboratorio/tutoria', laboratorio.tutoria);
  app.get('/laboratorio/tutoria/brechas', laboratorio.brechas);
  app.get('/laboratorio/modo', laboratorio.modo);
  app.get('/laboratorio/propuestas', laboratorio.propuestas);
  app.get('/laboratorio/curador', laboratorio.curador);
  app.post('/laboratorio/curador/proponer', laboratorio.proponerCurador);
  app.post('/laboratorio/ejecutar', laboratorio.ejecutar);
  app.get('/laboratorio/sugerencias-skills', laboratorio.sugerenciasSkills);
  app.post('/laboratorio/calibracion', laboratorio.guardarCalibracion);
  app.get('/laboratorio/calibracion', laboratorio.leerCalibracion);

  // Automatismo: cada día se recalcula el tutor (los modelos y precios cambian cada semana). Sin clave no hace nada y lo dice el laboratorio.
  if (process.env['KARAJAN_TUTOR_AUTO'] !== '0' && process.env['ARTIFICIAL_ANALYSIS_API_KEY']) {
    const reloj = setInterval(() => { void laboratorio.actualizar().catch(() => undefined); }, 24 * 3_600_000);
    reloj.unref?.();
    void laboratorio.actualizar().catch(() => undefined);
  }

  for (const [metodo, ruta] of [['post', '/resources/recommend'], ['post', '/resources/ingest-url'], ['post', '/executions'], ['post', '/ingest']] as const) {
    app[metodo](ruta, () => { throw falla(501, NO_DISPONIBLE); });
  }
}
