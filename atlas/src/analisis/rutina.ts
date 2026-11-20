import { clasificar } from './clasificador';
import { entradaDeCola, huellaOrigen, observadoDe } from './observado';
import type { Cadena } from './proveedores';
import { ficheroNuevo, type Bitacora, type Repositorio } from './repositorio';
import { TAXONOMIA_VERSION } from './taxonomia';
import { VERSION_ANALISIS, type AnalisisTarea, type EntradaTarea, type FicheroAnalisis } from './tipos';

/**
 * Rutina de análisis: toma las tareas del registro (y, si se le da, de la cola de Atlas dev), clasifica las que lo necesitan y
 * guarda el resultado. Es IDEMPOTENTE: una tarea ya analizada con la misma versión y el mismo contenido de origen se omite; si cambia
 * la versión del análisis, el anterior pasa a `historial` y no se pierde. Los fallos (cola, registro, modelo) se anotan en la
 * tarea (`proceso`) y en la bitácora sin tocar su análisis previo, y se reintentan en la siguiente pasada.
 */
export interface TareaCola { id: string; titulo: string; estado: string; prompt: string | null; hoja?: unknown; tipo?: string }
export interface Fuentes { repo: Repositorio; /** Lista las tareas de la cola; si lanza, se anota y se sigue con el registro. */ cola?: () => Promise<TareaCola[]> }
export interface OpcionesProceso { limite: number; forzar: boolean; maxIntentos: number; ahora?: () => Date; bitacora?: Bitacora }

export type Veredicto = 'analizada' | 'omitida' | 'pendiente' | 'fallida' | 'agotada';
export interface Informe {
  inicio: string;
  contadores: Record<Veredicto, number>;
  fuentes: { registro: { ok: boolean; error: string | null; tareas: number }; cola: { ok: boolean; error: string | null; tareas: number } | null };
  detalle: { id: string; veredicto: Veredicto; proveedor?: string; error?: string }[];
}

/** Estados de la cola que ya no cambian: solo esas se analizan desde la cola. */
const TERMINALES = new Set(['completada', 'fallida', 'descartada']);

export function necesita(previo: FicheroAnalisis | null, huella: string, forzar: boolean, maxIntentos: number): Veredicto | 'procesar' {
  if (!previo) return 'procesar';
  if (forzar) return 'procesar';
  const a = previo.actual;
  const vigente = previo.proceso.estado === 'ok' && a?.procedencia.version_analisis === VERSION_ANALISIS && a.procedencia.huella_origen === huella;
  if (vigente) return 'omitida';
  if (previo.proceso.estado === 'fallido' && previo.proceso.intentos >= maxIntentos && previo.proceso.version_objetivo === VERSION_ANALISIS) return 'agotada';
  return 'procesar';
}

export async function procesarPendientes(fuentes: Fuentes, cadena: Cadena, op: OpcionesProceso): Promise<Informe> {
  const ahora = op.ahora ?? (() => new Date());
  const log: Bitacora = op.bitacora ?? (() => {});
  const evento = (nivel: 'info' | 'aviso' | 'error', ev: string, tarea?: string, detalle?: string) => log({ ts: ahora().toISOString(), nivel, evento: ev, tarea, detalle });
  const informe: Informe = {
    inicio: ahora().toISOString(), contadores: { analizada: 0, omitida: 0, pendiente: 0, fallida: 0, agotada: 0 },
    fuentes: { registro: { ok: true, error: null, tareas: 0 }, cola: null }, detalle: [],
  };
  const anotar = (id: string, veredicto: Veredicto, extra: { proveedor?: string; error?: string } = {}) => { informe.contadores[veredicto]++; informe.detalle.push({ id, veredicto, ...extra }); };

  const candidatas: { id: string; carpeta: string; entrada: EntradaTarea }[] = [];
  try {
    for (const t of fuentes.repo.cargar()) {
      informe.fuentes.registro.tareas++;
      if (t.entrada) candidatas.push({ id: t.id, carpeta: t.carpeta, entrada: t.entrada });
      else { evento('error', 'registro-ilegible', t.id, t.error ?? undefined); anotar(t.id, 'fallida', { error: t.error ?? 'ilegible' }); }
    }
  } catch (e) {
    informe.fuentes.registro = { ok: false, error: (e as Error).message, tareas: 0 };
    evento('error', 'registro-inaccesible', undefined, (e as Error).message);
  }

  if (fuentes.cola) {
    informe.fuentes.cola = { ok: true, error: null, tareas: 0 };
    try {
      const vistas = new Set(candidatas.map((c) => c.id));
      for (const t of await fuentes.cola()) {
        if (!TERMINALES.has(t.estado) || vistas.has(t.id)) continue;
        informe.fuentes.cola.tareas++;
        candidatas.push({ id: t.id, carpeta: fuentes.repo.carpetaDe(t.id), entrada: entradaDeCola(t) });
      }
    } catch (e) {
      informe.fuentes.cola = { ok: false, error: (e as Error).message, tareas: 0 };
      evento('error', 'cola-inaccesible', undefined, (e as Error).message);
    }
  }

  let trabajo = 0;
  for (const c of candidatas) {
    const huella = huellaOrigen(c.entrada);
    const previo = fuentes.repo.leer(c.carpeta);
    const v = necesita(previo, huella, op.forzar, op.maxIntentos);
    if (v !== 'procesar') { anotar(c.id, v); continue; }
    if (trabajo >= op.limite) continue;
    trabajo++;

    const base = previo ?? ficheroNuevo(c.id);
    const guardar = (f: FicheroAnalisis): boolean => {
      try { fuentes.repo.escribir(c.carpeta, f); return true; } catch (e) { evento('error', 'escritura-fallida', c.id, (e as Error).message); return false; }
    };
    try {
      const observado = observadoDe(c.entrada);
      const r = await clasificar(c.entrada, observado, cadena);
      const proceso = { ultimo_intento: ahora().toISOString(), version_objetivo: VERSION_ANALISIS };
      if (r.estado === 'ok') {
        const analisis: AnalisisTarea = {
          observado, inferido: { etiquetas: r.etiquetas, notas: r.notas },
          procedencia: { version_analisis: VERSION_ANALISIS, taxonomia_version: TAXONOMIA_VERSION, proveedor: r.proveedor, modelo: r.modelo, prompt_hash: r.prompt_hash, huella_origen: huella, fecha: ahora().toISOString() },
        };
        // Un análisis de otra versión pasa al historial; el de la misma versión se sustituye (no hay duplicados por versión).
        const porVersion = new Map(base.historial.map((h) => [h.procedencia.version_analisis, h]));
        if (base.actual) porVersion.set(base.actual.procedencia.version_analisis, base.actual);
        porVersion.delete(VERSION_ANALISIS);
        const historial = [...porVersion.values()];
        if (guardar({ ...base, proceso: { ...proceso, estado: 'ok', intentos: 0, error: null }, actual: analisis, historial })) { anotar(c.id, 'analizada', { proveedor: r.proveedor }); evento('info', 'analizada', c.id, r.proveedor); }
        else anotar(c.id, 'fallida', { error: 'no se pudo escribir el análisis' });
      } else if (r.estado === 'pendiente') {
        // Nadie disponible: no cuenta como intento fallido, se reintenta cuando haya modelo.
        guardar({ ...base, proceso: { ...proceso, estado: 'pendiente', intentos: base.proceso.intentos, error: r.error } });
        evento('aviso', 'sin-modelo', c.id, r.error ?? undefined);
        anotar(c.id, 'pendiente', { error: r.error ?? undefined });
      } else {
        guardar({ ...base, proceso: { ...proceso, estado: 'fallido', intentos: base.proceso.intentos + 1, error: r.error } });
        evento('error', 'modelo-fallido', c.id, r.error ?? undefined);
        anotar(c.id, 'fallida', { error: r.error ?? undefined });
      }
    } catch (e) {
      evento('error', 'analisis-fallido', c.id, (e as Error).message);
      guardar({ ...base, proceso: { estado: 'fallido', intentos: base.proceso.intentos + 1, error: (e as Error).message, ultimo_intento: ahora().toISOString(), version_objetivo: VERSION_ANALISIS } });
      anotar(c.id, 'fallida', { error: (e as Error).message });
    }
  }
  return informe;
}

/** Resumen del estado del histórico: cuántas tareas hay por estado de proceso y por versión de análisis. */
export function estadoHistorico(repo: Repositorio) {
  const todos = repo.todos();
  const porEstado: Record<string, number> = {}, porVersion: Record<string, number> = {};
  for (const f of todos) {
    porEstado[f.proceso.estado] = (porEstado[f.proceso.estado] ?? 0) + 1;
    const v = f.actual?.procedencia.version_analisis;
    if (v !== undefined) porVersion[String(v)] = (porVersion[String(v)] ?? 0) + 1;
  }
  return { total: todos.length, version_actual: VERSION_ANALISIS, taxonomia_version: TAXONOMIA_VERSION, por_estado: porEstado, por_version: porVersion, con_error: todos.filter((f) => f.proceso.error).map((f) => ({ id: f.tarea_id, estado: f.proceso.estado, intentos: f.proceso.intentos, error: f.proceso.error })) };
}

/** Muestras para dpw7 (`Muestra` de evolucion.ts): una por tarea analizada, con `null` donde la cola no lo sabe. */
export function exportarMuestras(repo: Repositorio) {
  return repo.todos().filter((f) => f.actual).map((f) => {
    const a = f.actual!, et = (eje: string) => a.inferido.etiquetas.find((e) => e.eje === eje);
    const ok = a.observado.resultado === 'validada' ? true : a.observado.resultado === 'fallida' ? false : a.observado.validada;
    return {
      tarea: a.observado.id, perfil: a.observado.perfil, agente: a.observado.agente, modelo: a.observado.modelo,
      nivel: et('nivel')?.valor ?? null, dominio: et('dominio')?.valor ?? null, tipo: et('tipo')?.valor ?? null,
      resultado: a.observado.resultado, ok, coste_usd: a.observado.coste_usd, duracion_activa_ms: a.observado.duracion_activa_ms,
      redirecciones: a.observado.correcciones?.redirecciones ?? null,
      version_analisis: a.procedencia.version_analisis, taxonomia_version: a.procedencia.taxonomia_version, proveedor: a.procedencia.proveedor,
    };
  });
}
