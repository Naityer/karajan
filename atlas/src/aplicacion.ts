import { ErrorPerfil } from './perfiles';
import { type PeticionMutacion } from './modo';
import { type crearRuntime } from './runtime';
import { construirAnaliticaSkills } from './analitica';
import { catalogoReal, listarSkills } from './catalogo';
import { calcularProduccion } from './produccion';
import { perfilPorDefecto } from './perfiles';
import { detectarNecesidades, explicacion, fitnessPerfil, MIN_MUESTRAS, muestrasDeFilas, proponerGeneracion } from './evolucion';
import { disponibilidad, PROVEEDORES } from './proveedores';

const falla = (estado: number, detail: string) => Object.assign(new Error(detail), { status: estado });
const CAMPOS_REVISION = new Set(['agente_entrada', 'agente', 'skills_usadas', 'categoria_skill', 'nivel_tarea', 'dominio', 'intencion', 'palabras_clave']);

/** Operaciones compartidas entre adaptadores; no conocen rutas ni respuestas HTTP. */
export function crearAplicacion(runtime: ReturnType<typeof crearRuntime>) {
  const { perfiles, rutaLayout, delegador, rotador, mutar, almacen } = runtime;
  const conPerfil = <T,>(fn: () => T): T => {
    try { return fn(); } catch (e) { if (e instanceof ErrorPerfil) throw falla(422, e.message); throw e; }
  };
  const leerPrompt = (body: unknown) => {
    const prompt = typeof (body as { prompt?: unknown } | null)?.prompt === 'string' ? ((body as { prompt: string }).prompt).trim() : '';
    if (!prompt) throw falla(422, 'prompt cannot be blank');
    if (prompt.length > 20_000) throw falla(422, 'prompt demasiado largo (máx. 20000 caracteres)');
    return prompt;
  };
  const entero = (v: string | undefined, defecto: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== '' ? Math.min(max, Math.max(min, Math.trunc(n))) : defecto;
  };
  const calcular = (q: Record<string, string | undefined>) => calcularProduccion(almacen.tareasPlanas(), q, {
    catalogo: catalogoReal,
    perfil: () => perfilPorDefecto(perfiles.leer()),
    disponibles: () => new Map(PROVEEDORES.map((pr) => [pr.nombre, disponibilidad(pr).disponible] as const)),
    ahora: () => new Date(),
  });
  const cabecera = (p: ReturnType<typeof calcular>) => ({ dias: p.dias, perfil: p.perfil, agentes_perfil: p.agentes_perfil, ultima: p.ultima, kpis: p.kpis });
  return {
    guardarRevisiones: (body: unknown) => {
      const lista = (body as { revisiones?: unknown } | null)?.revisiones;
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
    },
    analiticaSkills: (q: Record<string, string | undefined>) => {
      const dias = entero(q['days'], 30, 0, 3650);
      const registros = almacen.listarTareas();
      const runsPorTarea = Object.fromEntries(registros.filter((r) => r.delegation).map((r) => [r.task_id, almacen.runs(r.task_id)]));
      const revisadas = Object.fromEntries(Object.entries(almacen.revisiones()).map(([id, campos]) => [id, campos['skills_usadas'] ?? []]));
      return construirAnaliticaSkills(registros, { runsPorTarea, skillsRevisadasPorTarea: revisadas, skillsConocidas: listarSkills().map((s) => s.name), dias });
    },
    buscarTareas: (q: Record<string, string | undefined>) => {
      const texto = q['q'] ?? '';
      const resultados = almacen.buscar(texto, entero(q['limit'], 20, 1, 100));
      return { query: texto, count: resultados.length, results: resultados };
    },
    produccion: (q: Record<string, string | undefined>) => { const { acierto: _a, ...p } = calcular(q); return p; },
    flujo: (q: Record<string, string | undefined>) => { const p = calcular(q); return { ...cabecera(p), ...p.flujo }; },
    eficiencia: (q: Record<string, string | undefined>) => { const p = calcular(q); return { ...cabecera(p), ...p.eficiencia }; },
    matrizSkills: (q: Record<string, string | undefined>) => { const p = calcular(q); return { ...cabecera(p), ...p.matriz }; },
    sugerencias: (q: Record<string, string | undefined>) => { const p = calcular(q); return { ...cabecera(p), sugerencias: p.sugerencias }; },
    acierto: (q: Record<string, string | undefined>) => { const p = calcular(q); return { ...cabecera(p), tareas: p.acierto }; },
    catalogoSkills: (q: Record<string, string | undefined>) => { const p = calcular({ dias: q['dias'] ?? '90', perfil: 'todos' }); return { dias: p.dias, ...p.catalogo }; },
    clasificar: (body: unknown) => delegador.planificar(leerPrompt(body)).clasificacion,
    planificar: (body: unknown) => {
      const b = (body ?? {}) as { force_entity_id?: unknown };
      return delegador.planificar(leerPrompt(body), typeof b.force_entity_id === 'string' ? b.force_entity_id : null);
    },
    delegar: (body: unknown) => {
      const b = (body ?? {}) as { force_entity_id?: unknown; cwd?: unknown; human_approved?: unknown; entry_agent?: unknown };
      return delegador.delegar(leerPrompt(body), { forzarEntidad: typeof b.force_entity_id === 'string' ? b.force_entity_id : null, cwd: b.cwd, aprobada: b.human_approved === true, entrada: typeof b.entry_agent === 'string' ? b.entry_agent : null });
    },
    leerPerfil: () => ({ ...perfiles.leer(), path: rutaLayout }),
    guardarPerfil: (req: PeticionMutacion & { body: unknown }) => mutar(req, 'PUT /routing-layout', () => conPerfil(() => perfiles.guardar(req.body))),
    presetDominios: (req: PeticionMutacion & { body: unknown }) => mutar(req, 'POST /routing-layout/presets/dominios', () => conPerfil(() => perfiles.aplicarPresetDominio({ porDefecto: (req.body as { por_defecto?: unknown } | null)?.por_defecto !== false }))),
    presetNivel: (req: PeticionMutacion & { body: unknown }) => mutar(req, 'POST /routing-layout/presets/nivel', () => conPerfil(() => perfiles.aplicarPresetNivel({ porDefecto: (req.body as { por_defecto?: unknown } | null)?.por_defecto !== false }))),
    presetBase: (req: PeticionMutacion & { body: unknown }) => mutar(req, 'POST /routing-layout/presets/base', () => conPerfil(() => perfiles.aplicarPresetBase({ porDefecto: (req.body as { por_defecto?: unknown } | null)?.por_defecto !== false }))),
    fitnessEvolucion: () => {
      const perfil = perfilPorDefecto(perfiles.leer());
      const muestras = muestrasDeFilas(almacen.filasEvolucion());
      return { profile_id: perfil.id, min_muestras: MIN_MUESTRAS, fitness: fitnessPerfil(perfil, muestras), necesidades: detectarNecesidades(perfil, muestras).map((n) => ({ ...n, explicacion: explicacion(n) })) };
    },
    proponerEvolucion: (req: PeticionMutacion & { body: unknown }) => mutar(req, 'POST /routing-layout/evolucion/proponer', () => conPerfil(() => {
      const l = perfiles.leer();
      return perfiles.guardarHijos(proponerGeneracion(l.profiles, l.default_profile_id, muestrasDeFilas(almacen.filasEvolucion())));
    })),
    perfilDesdeTexto: (req: PeticionMutacion & { body: unknown }) => {
      const b = (req.body ?? {}) as { texto?: unknown; perfil_id?: unknown; aplicar?: unknown };
      const texto = typeof b.texto === 'string' ? b.texto.trim().slice(0, 2000) : '';
      if (!texto) throw falla(422, 'Escribe cómo quieres el perfil');
      const operacion = () => conPerfil(() => perfiles.desdeTexto(texto, { perfilId: typeof b.perfil_id === 'string' ? b.perfil_id : undefined, aplicar: b.aplicar === true }));
      return b.aplicar === true ? mutar(req, 'POST /routing-layout/desde-texto', operacion) : operacion();
    },
    consultarRotacion: () => {
      const inventario = rotador.inventario();
      const cuenta = (n: string) => inventario.filter((f) => f.nivel === n && f.instaladaEn.length).length;
      return { config: rotador.leerEstado().config, resumen: { nucleo: cuenta('nucleo'), frecuente: cuenta('frecuente'), instantanea: cuenta('instantanea'), inactivas_instaladas: cuenta('inactiva'), en_almacen: inventario.filter((f) => f.enAlmacen.length && !f.instaladaEn.length).length }, plan: rotador.plan(), inventario };
    },
    rotar: (req: PeticionMutacion & { body: unknown }) => {
      const aplicar = (req.body as { aplicar?: unknown } | null)?.aplicar === true;
      const operacion = () => { const plan = rotador.plan(); return { aplicado: aplicar, ...(aplicar ? rotador.aplicar(plan) : plan) }; };
      return aplicar ? mutar(req, 'POST /skills/rotar (aplicar)', operacion) : operacion();
    },
  };
}
