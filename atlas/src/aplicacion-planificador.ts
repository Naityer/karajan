import { join } from 'node:path';
import { claseDe, estimar } from './dosificador';
import { disponibilidad, PROVEEDORES } from './proveedores';
import { planificar, type ContextoPlanificador, type PlanEjecucion } from './planificador';
import { DESCRIPCION_MODOS, familiaDe, validarCombinacion, type SolicitudModo } from './planificador-modos';
import { anotarEvento, guardarChecker, guardarConfig, guardarPlan, leerConfig, leerPlan, listarPlanes } from './planificador-registro';
import { type PeticionMutacion } from './modo';
import { type crearRuntime } from './runtime';
import { type crearAplicacionDosificador } from './aplicacion-dosificador';

const falla = (estado: number, detail: string) => Object.assign(new Error(detail), { status: estado });
const nivelDe = (c: string) => Number(/[1-5]/.exec(c)?.[0] ?? 2);

/**
 * Operaciones del planificador: aquí se juntan lo que el planificador (puro) no conoce —el delegador que clasifica y elige agente, el
 * dosificador que estima el coste y mide la cuota, la producción que mide el acierto, los proveedores que dicen qué hay instalado— y
 * el registro de planes. Solo DECIDE: ejecutar el plan es cosa de la cola de Atlas dev.
 */
export function crearAplicacionPlanificador(runtime: ReturnType<typeof crearRuntime>, dosificador: ReturnType<typeof crearAplicacionDosificador>) {
  const { dirDatos, delegador, almacen, mutar } = runtime;
  const rutaCfg = join(dirDatos, 'planificador.json'), rutaPlanes = join(dirDatos, 'planificador-planes.json');
  const config = () => leerConfig(rutaCfg);

  const contexto = (): ContextoPlanificador => {
    const cfg = config(), dos = dosificador.configDos(), est = dosificador.estadoDos();
    const rendimiento = (() => { try { return almacen.rendimientoAgentes(); } catch { return []; } })();
    return {
      config: cfg,
      coste: (agente, nivel, dominio) => {
        if (!dos.planes[agente]) return null;
        const e = estimar(est, dos, claseDe(nivel, dominio, agente));
        return { pct: e.p, fuente: e.fuente };
      },
      acierto: (agente) => {
        const f = rendimiento.filter((r) => familiaDe(r.provider_name) === agente);
        const n = f.reduce((s, r) => s + r.task_count, 0);
        return n ? { valor: 1 - f.reduce((s, r) => s + r.error_count, 0) / n, n } : null;
      },
      cuota: () => { try { const m = dosificador.estado().modo; return m === 'normal' || m === 'frenado' || m === 'bloqueado' ? { modo: m } : null; } catch { return null; } },
      disponible: (agente) => { const p = PROVEEDORES.filter((x) => familiaDe(x.nombre) === agente); return p.length ? p.some((x) => disponibilidad(x).disponible) : true; },
    };
  };

  const leerSolicitud = (b: Record<string, unknown>): SolicitudModo => ({
    modo: typeof b['modo'] === 'string' ? b['modo'] : undefined, modificadores: Array.isArray(b['modificadores']) ? b['modificadores'].map(String) : undefined,
    principal: b['principal'] && typeof b['principal'] === 'object' ? b['principal'] as SolicitudModo['principal'] : undefined,
    subagentes: Array.isArray(b['subagentes']) ? b['subagentes'].filter((x) => x && typeof x === 'object') as SolicitudModo['subagentes'] : undefined,
    checker: b['checker'] && typeof b['checker'] === 'object' ? b['checker'] as SolicitudModo['checker'] : b['checker'] === true ? true : undefined,
  });

  /** Clasifica el prompt, elige agente con el delegador y construye el plan; con `tarea` (y sin `simulacro`) lo guarda. */
  const crearPlan = (body: unknown) => {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const prompt = typeof b['prompt'] === 'string' ? b['prompt'].trim() : '';
    if (!prompt) throw falla(422, 'prompt cannot be blank');
    if (prompt.length > 20_000) throw falla(422, 'prompt demasiado largo (máx. 20000 caracteres)');
    if (b['tarea'] !== undefined && (typeof b['tarea'] !== 'string' || !b['tarea'] || b['tarea'].length > 80)) throw falla(422, 'tarea: el id de la tarea (1 a 80 caracteres)');
    const solicitud = leerSolicitud(b), validacion = validarCombinacion(solicitud);
    if (!validacion.ok) return { plan: planificar({ solicitud, tarea: { nivel: 1, dominio: [], subtareas: [] } }, contexto()), guardado: false };
    const lp = delegador.planificar(prompt), c = lp.clasificacion;
    const agente = typeof b['agente'] === 'string' ? b['agente'] : lp.asignaciones[0] ? familiaDe(lp.asignaciones[0].proveedor) : undefined;
    const plan: PlanEjecucion = planificar({ solicitud, agente, tarea: { nivel: nivelDe(c.complexity_level), dominio: c.domain, subtareas: c.subtasks.map((s) => ({ nombre: s.name, validacion: s.validation, complejidad: s.complexity })) } }, contexto());
    const guardar = typeof b['tarea'] === 'string' && b['simulacro'] !== true;
    return { plan, guardado: guardar, ...(guardar ? { registro: guardarPlan(rutaPlanes, b['tarea'] as string, plan) } : {}) };
  };

  return {
    config, contexto, crearPlan, listaPlanes: () => listarPlanes(rutaPlanes),
    modos: () => ({ modos: DESCRIPCION_MODOS, agentes: Object.entries(config().agentes).map(([id, a]) => ({ id, activo: a.activo, niveles: a.niveles })), jefe: config().jefe }),
    validar: (body: unknown) => { const v = validarCombinacion(leerSolicitud((body && typeof body === 'object' ? body : {}) as Record<string, unknown>)); return v; },
    consultarConfig: () => ({ config: config(), fichero: rutaCfg }),
    cambiarConfig: async (req: PeticionMutacion & { body: unknown }) => mutar(req, 'PUT /planificador/config', () => {
      const b = req.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw falla(422, 'config: un objeto con los campos a cambiar');
      const { tarea: _t, ...resto } = b as Record<string, unknown>;
      return { config: guardarConfig(rutaCfg, resto['config'] && typeof resto['config'] === 'object' ? resto['config'] : resto), fichero: rutaCfg };
    }),
    planes: () => ({ planes: listarPlanes(rutaPlanes).map((r) => ({ tarea: r.tarea, modo: r.plan.modo, modificadores: r.plan.modificadores, estado: r.estado, actualizado: r.actualizado, checker: r.checker?.estado ?? null, errores: r.plan.errores.length })) }),
    plan: (id: string) => { const r = leerPlan(rutaPlanes, id); if (!r) throw falla(404, `No hay plan para la tarea «${id}»`); return r; },
    /** Atlas dev avisa de lo que pasó al ejecutar el plan (hito completado, paso fallido, tarea bloqueada…). Un estado desconocido se rechaza. */
    evento: (body: unknown) => {
      const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      if (typeof b['tarea'] !== 'string' || !b['tarea']) throw falla(422, 'tarea: el id de la tarea');
      if (!['plan', 'estado', 'hito', 'decision', 'fallo'].includes(String(b['tipo']))) throw falla(422, 'tipo: plan | estado | hito | decision | fallo');
      if (typeof b['detalle'] !== 'string' || !b['detalle'].trim()) throw falla(422, 'detalle: texto del evento');
      try {
        const r = anotarEvento(rutaPlanes, b['tarea'], { tipo: b['tipo'] as 'estado', detalle: b['detalle'], estado: typeof b['estado'] === 'string' ? b['estado'] : undefined });
        if (!r) throw falla(404, `No hay plan para la tarea «${b['tarea']}»`);
        return { ok: true, estado: r.estado };
      } catch (e) { if ((e as { status?: number }).status) throw e; throw falla(422, (e as Error).message); }
    },
    /** El checker terminó (o no pudo): sus hallazgos quedan en el plan; si falló, el plan queda bloqueado y NO como revisado. */
    checker: (body: unknown) => {
      const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
      if (typeof b['tarea'] !== 'string' || !b['tarea']) throw falla(422, 'tarea: el id de la tarea');
      if (!['limpio', 'hallazgos', 'fallido'].includes(String(b['estado']))) throw falla(422, 'estado: limpio | hallazgos | fallido');
      const r = guardarChecker(rutaPlanes, b['tarea'], { estado: String(b['estado']), resumen: typeof b['resumen'] === 'string' ? b['resumen'] : undefined, hallazgos: b['hallazgos'] });
      if (!r) throw falla(404, `No hay plan para la tarea «${b['tarea']}»`);
      return { ok: true, checker: r.checker, estado: r.estado };
    },
  };
}
