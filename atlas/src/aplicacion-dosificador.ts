import { join } from 'node:path';
import { leerLimitesSinCaducidad, rutaLimites } from './limites';
import { circuitoAbierto, decidir, decidirSolicitud, decidirRelevo, estimar, registrarCoste, registrarLimite, validarRelevo } from './dosificador';
import { guardarConfig as guardarConfigDos, guardarEstado as guardarEstadoDos, leerConfig as leerConfigDos, leerEstado as leerEstadoDos, type EstadoDosificador } from './dosificador-config';
import { tiempoMs } from './dosificador-cuota';
import { simularSolicitud } from './dosificador-sim';
import { type PeticionMutacion } from './modo';
import { type crearRuntime } from './runtime';

const falla = (estado: number, detail: string) => Object.assign(new Error(detail), { status: estado });
class ErrorEstadoDosificador extends Error {
  readonly status = 503;
}

/** Operaciones de dosificador reutilizables, independientes de la interfaz HTTP. */
export function crearAplicacionDosificador(datos: string, mutar: ReturnType<typeof crearRuntime>['mutar']) {
  const rutaDosCfg = join(datos, 'dosificador.json'), rutaDosEstado = join(datos, 'dosificador-estado.json');
  const configDos = () => leerConfigDos(rutaDosCfg);
  const estadoDos = () => leerEstadoDos(rutaDosEstado);
  const guardarEstadoDosSeguro = (e: EstadoDosificador) => {
    try { guardarEstadoDos(rutaDosEstado, e); }
    catch (error) {
      throw new ErrorEstadoDosificador(`No se pudo guardar el estado del dosificador en ${rutaDosEstado}; comprueba la ruta, los permisos y el espacio disponible. ${String((error as Error).message ?? error)}`);
    }
  };
  const isoOrNull = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const malaPeticion = (error: string) => ({ error });

  const tomarDecision = (body: unknown) => {
    try {
      const cfg = configDos();
      const v = decidirSolicitud(body, cfg, estadoDos());
      if (!v.ok) return malaPeticion(v.error);
      const r = v.resultado;
      // `simulacro: true` decide sin guardar el estado (lo usa `kj dosificador decidir`).
      if ((body as { simulacro?: unknown }).simulacro !== true) guardarEstadoDosSeguro(r.estado);
      return { decisiones: r.decisiones, diferidas: r.diferidas, estado: r.resumen };
    } catch (e) { if (e instanceof ErrorEstadoDosificador) throw e; return malaPeticion(`no se pudo decidir: ${String((e as Error).message ?? e).slice(0, 200)}`); }
  };

  /** Una tarea terminó (o topó con el límite): su coste real alimenta al estimador, su lease se libera y un límite abre el circuito del agente. */
  const observar = (body: unknown) => {
    const cfg = configDos(), b = (body ?? {}) as Record<string, unknown>;
    const agente = typeof b['agente'] === 'string' ? b['agente'] : '';
    if (!cfg.planes[agente]) return malaPeticion(`agente: ${Object.keys(cfg.planes).join('|')}`);
    if (typeof b['tarea'] !== 'string' || !b['tarea'] || b['tarea'].length > 80) return malaPeticion('tarea: el id de la tarea (1 a 80 caracteres)');
    if (b['clase'] !== undefined && b['clase'] !== null && (typeof b['clase'] !== 'string' || !b['clase'] || b['clase'].length > 120)) return malaPeticion('clase: texto «nivel|dominio|agente» de hasta 120 caracteres');
    const coste = b['costePct'];
    if (coste !== undefined && coste !== null && (typeof coste !== 'number' || !Number.isFinite(coste) || coste < 0 || coste > 1000)) return malaPeticion('costePct: porcentaje del plan semanal entre 0 y 1000');
    const lim = b['limiteAlcanzado'];
    if (lim !== undefined && lim !== null && lim !== false && (typeof lim !== 'object' || Array.isArray(lim))) return malaPeticion('limiteAlcanzado: {resetsAt}');
    let est = estadoDos();
    const clase = typeof b['clase'] === 'string' ? b['clase'] : est.leases[b['tarea']]?.clase || null;
    est = registrarCoste(est, cfg, { tarea: b['tarea'], agente, clase: clase ?? undefined, costePct: typeof coste === 'number' ? coste : null });
    if (lim) est = registrarLimite(est, cfg, agente, tiempoMs((lim as { resetsAt?: unknown }).resetsAt), Date.now());
    guardarEstadoDosSeguro(est);
    const ahora = Date.now();
    return {
      ok: true, clase, aprendido: clase !== null && typeof coste === 'number', circuito_hasta: isoOrNull(circuitoAbierto(est, agente, ahora)),
      estimacion: clase ? (({ media, sigma, p, n }) => ({ media, sigma, p80: p, n }))(estimar(est, cfg, clase)) : null,
    };
  };

  /** Cuota de cada agente, modo, burn rate, agotamiento proyectado, circuitos, tareas en vuelo y la última decisión. Solo lectura. */
  const estado = () => {
    const cfg = configDos(), est = estadoDos(), ahora = Date.now(), l = leerLimitesSinCaducidad(rutaLimites());
    const nombres = Object.keys(cfg.planes);
    const r = decidir({
      ahora, tareas: [], equipos: [], agentes: Object.fromEntries(nombres.map((a) => [a, { disponible: true, enCurso: 0 }])),
      uso: Object.fromEntries(nombres.map((a) => [a, (l as unknown as Record<string, unknown> | null)?.[a] ?? {}])), leido: l && Number.isFinite(Date.parse(l.leido)) ? l.leido : undefined,
    }, cfg, est);
    return {
      ahora: new Date(ahora).toISOString(), ...r.resumen, simulacion: cfg.modoSimulacion, agentes: r.agentes,
      cuota: { fichero: rutaLimites(), leido: l?.leido ?? null },
      ultima_decision: est.ultima ? { en: isoOrNull(est.ultima.en), decisiones: est.ultima.decisiones, diferidas: est.ultima.diferidas } : null,
      en_vuelo: Object.entries(est.leases).map(([tarea, x]) => ({ tarea, agente: x.agente, equipo: x.equipo, coste_p80_pct: x.costePct, lanzar_en: isoOrNull(x.lanzarEn), hasta: isoOrNull(x.hasta) })),
      clases_aprendidas: Object.keys(est.estimador).filter((k) => !k.startsWith('*')).length,
    };
  };

  /**
   * Relevo entre equipos: el destino (el servidor) pregunta si toma ya una tarea que empezó otro equipo. Solo DECIDE; la anota en el
   * registro de relevos del estado (`GET /dosificador/decisiones`). `simulacro: true` decide sin guardar.
   */
  const relevo = (body: unknown) => {
    try {
      const cfg = configDos();
      const v = validarRelevo(body, cfg);
      if (!v.ok) return malaPeticion(v.error);
      const r = decidirRelevo(v.entrada, cfg, estadoDos());
      if ((body as { simulacro?: unknown }).simulacro !== true) guardarEstadoDosSeguro(r.estado);
      return r.decision;
    } catch (e) { if (e instanceof ErrorEstadoDosificador) throw e; return malaPeticion(`no se pudo decidir el relevo: ${String((e as Error).message ?? e).slice(0, 200)}`); }
  };

  /** Las últimas decisiones de relevo (más recientes primero), con la política y los parámetros vigentes. Solo lectura. */
  const decisiones = () => {
    const cfg = configDos();
    return {
      relevo: cfg.relevo, equipos: cfg.equipos, topes: Object.fromEntries(Object.entries(cfg.planes).map(([a, p]) => [a, { topePct: p.topePct ?? null, ritmoMaxPctHora: p.ritmoMaxPctHora ?? null }])),
      relevos: [...estadoDos().relevos].reverse().map((x) => ({ ...x, en: isoOrNull(x.en), lanzarEn: isoOrNull(x.lanzarEn) })),
    };
  };

  const consultarConfig = () => ({ config: configDos(), fichero: rutaDosCfg });
  const cambiarConfig = async (req: PeticionMutacion & { body: unknown }) => {
    return mutar(req, 'PUT /dosificador/config', () => {
      const b = req.body;
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw falla(422, 'config: un objeto con los campos a cambiar');
      const { tarea: _tarea, ...resto } = b as Record<string, unknown>;
      const parcial = resto['config'] && typeof resto['config'] === 'object' ? resto['config'] : resto;
      return { config: guardarConfigDos(rutaDosCfg, parcial), fichero: rutaDosCfg };
    });
  };

  /** Simula semanas sintéticas con la configuración viva (solo lectura; hasta 12 semanas para no bloquear el proceso). */
  const simular = (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return simularSolicitud(configDos(), b);
  };

  return { configDos, estadoDos, tomarDecision, observar, estado, relevo, decisiones, consultarConfig, cambiarConfig, simular };
}
