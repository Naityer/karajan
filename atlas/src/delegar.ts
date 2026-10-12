import { resolve as resolverRuta, sep } from 'node:path';

import type { Almacen } from './almacen';
import { clasificar, type Clasificacion, type Configuracion, type Subtarea } from './heuristica';
import { perfilPorDefecto, type Perfiles } from './perfiles';
import { disponibilidad, ejecutarProveedor, modeloPara, proveedor, type Disponibilidad, type Ejecutor, type Proveedor, type Tier } from './proveedores';
import { elegirRegla, nivelRegla, type Entidad, type Regla } from './reglas';

/**
 * Delegación real desde el paquete: clasifica el prompt (heurística), elige el agente de cada subtarea con el perfil POR DEFECTO
 * (sus reglas por dominio y, si ninguna casa, sus niveles), ejecuta el CLI de ese agente y lo registra todo en `task_logs.db`
 * (tarea, decisiones y runs, con el esquema de Karajan). La ejecución va en segundo plano: `delegar` devuelve el plan enseguida y
 * el resultado se lee después con `/tasks/:id`, `/tasks/:id/runs` y `/tasks/:id/decisions`.
 */
const NIVEL_NOMBRE = ['level_1_simple', 'level_2_moderate', 'level_3_intermediate', 'level_4_complex', 'level_5_critical'];
const TIMEOUT_MS = 15 * 60_000;
/** Orden de respaldo cuando el agente elegido no está disponible en este equipo. */
const RESPALDO = ['codex', 'claude-cli', 'ollama-qwen'];

export interface Asignacion { subtarea: string; nombre: string; entidad: string | null; entidad_nombre: string | null; proveedor: string; modelo: string; regla: string | null; motivo: string }
export interface Plan { task_id: string; status: string; clasificacion: Clasificacion; asignaciones: Asignacion[]; bloqueada: string | null }

interface Opciones {
  almacen: Almacen; perfiles: Perfiles; config: () => Configuracion; raiz: string;
  ejecutor?: Ejecutor; disponible?: (p: Proveedor) => Disponibilidad;
}

export class Delegador {
  private readonly ejecutor: Ejecutor;
  private readonly disponible: (p: Proveedor) => Disponibilidad;
  private readonly enCurso = new Map<string, number>();
  private readonly esperas = new Map<string, (() => void)[]>();
  readonly pendientes = new Set<Promise<void>>();

  constructor(private readonly op: Opciones) {
    this.ejecutor = op.ejecutor ?? ejecutarProveedor;
    const cache = new Map<string, { en: number; d: Disponibilidad }>();
    this.disponible = op.disponible ?? ((p) => { const c = cache.get(p.nombre); if (c && Date.now() - c.en < 30_000) return c.d; const d = disponibilidad(p); cache.set(p.nombre, { en: Date.now(), d }); return d; });
  }

  /** La carpeta de trabajo debe estar dentro de la raíz permitida (el Workspace). */
  carpeta(cwd: unknown): string {
    const raiz = resolverRuta(this.op.raiz);
    if (cwd === undefined || cwd === null || cwd === '') return raiz;
    if (typeof cwd !== 'string') throw Object.assign(new Error('cwd no válido'), { status: 422 });
    const r = resolverRuta(cwd);
    if (r !== raiz && !r.startsWith(raiz + sep)) throw Object.assign(new Error(`La carpeta debe estar dentro de ${raiz}`), { status: 403 });
    return r;
  }

  /** Qué agente haría cada subtarea, sin ejecutar nada (el probador del panel de perfiles). */
  planificar(prompt: string, forzarEntidad?: string | null): Plan {
    const c = clasificar(prompt, this.op.config());
    return { task_id: c.task_id, status: 'classified', clasificacion: c, asignaciones: c.subtasks.map((st) => this.asignar(c, st, forzarEntidad ?? null)), bloqueada: null };
  }

  private asignar(c: Clasificacion, st: Subtarea, forzar: string | null): Asignacion {
    const perfil = perfilPorDefecto(this.op.perfiles.leer());
    const tier = st.recommended_model as Tier;
    const base = { subtarea: st.id, nombre: st.name };
    const conEntidad = (e: Entidad, regla: Regla | null, motivo: string): Asignacion | null => {
      const p = proveedor(e.provider);
      if (!p) return null;
      return { ...base, entidad: e.id, entidad_nombre: e.name ?? e.id, proveedor: p.nombre, modelo: modeloPara(p, tier), regla: regla?.id ?? null, motivo };
    };
    if (forzar) {
      const e = perfil.entities.find((x) => x.id === forzar);
      const a = e && conEntidad(e, null, 'agente elegido a mano');
      if (!a) throw Object.assign(new Error(`El agente «${forzar}» no existe en el perfil por defecto o no se puede ejecutar desde el paquete`), { status: 422 });
      return a;
    }
    const m = elegirRegla(perfil, { dominios: c.domain, intencion: c.intent, nivel: nivelRegla(c.complexity_level, st.complexity), prompt: c.original_prompt });
    let a = m ? conEntidad(m.entidad, m.regla, `regla «${m.regla.name || m.regla.id}»`) : null;
    if (!a) {
      const nivel = NIVEL_NOMBRE[st.complexity - 1]!;
      const e = perfil.entities.find((x) => (x.levels ?? []).includes(nivel) && proveedor(x.provider)) ?? perfil.entities.find((x) => proveedor(x.provider));
      a = e ? conEntidad(e, null, `nivel ${st.complexity}`) : null;
    }
    // Si el agente elegido no puede ejecutarse aquí, el primero disponible del respaldo (queda anotado en el motivo).
    if (!a || !this.disponible(proveedor(a.proveedor)!).disponible) {
      const motivo = a ? `${a.proveedor} no disponible (${this.disponible(proveedor(a.proveedor)!).motivo})` : 'ningún agente del perfil se puede ejecutar';
      for (const nombre of RESPALDO) {
        const p = proveedor(nombre)!;
        if (!this.disponible(p).disponible) continue;
        const e = perfil.entities.find((x) => x.provider === nombre);
        return { ...base, entidad: e?.id ?? null, entidad_nombre: e?.name ?? null, proveedor: nombre, modelo: modeloPara(p, tier), regla: null, motivo: `${motivo}; respaldo ${nombre}` };
      }
      if (a) return { ...a, motivo: `${motivo}; sin respaldo disponible` };
      return { ...base, entidad: null, entidad_nombre: null, proveedor: 'codex', modelo: 'default', regla: null, motivo };
    }
    return a;
  }

  /** Clasifica, registra y lanza la ejecución en segundo plano. */
  delegar(prompt: string, { forzarEntidad = null, cwd, aprobada = false }: { forzarEntidad?: string | null; cwd?: unknown; aprobada?: boolean } = {}): Plan {
    const carpeta = this.carpeta(cwd);
    const plan = this.planificar(prompt, forzarEntidad);
    const c = plan.clasificacion;
    const { almacen } = this.op;
    almacen.guardarTarea(c, 'classified');
    almacen.registrarDecision({ task_id: c.task_id, phase: 'classify', decision: `model=${c.recommended_model}`, score: c.complexity_score, reason: c.reason });
    if (c.requires_human_review && !aprobada) {
      almacen.registrarDecision({ task_id: c.task_id, phase: 'delegate', decision: 'withheld:human_review', reason: 'La tarea exige revisión humana: vuelve a delegarla aprobándola.' });
      return { ...plan, bloqueada: 'La tarea exige revisión humana antes de ejecutarse.' };
    }
    for (const a of plan.asignaciones) {
      almacen.registrarDecision({ task_id: c.task_id, phase: 'assign', decision: a.regla ? `rule:${a.regla}->${a.entidad}:${a.proveedor}` : `${a.subtarea}->${a.entidad ?? '-'}:${a.proveedor}`, reason: a.motivo });
    }
    almacen.actualizarTarea(c.task_id, 'delegated', null);
    const trabajo = this.ejecutar(c, plan.asignaciones, carpeta).catch(() => { /* registrado dentro */ });
    this.pendientes.add(trabajo);
    void trabajo.finally(() => this.pendientes.delete(trabajo));
    return { ...plan, status: 'delegated' };
  }

  private async turno(entidad: string, max: number): Promise<() => void> {
    while ((this.enCurso.get(entidad) ?? 0) >= max) await new Promise<void>((r) => { this.esperas.set(entidad, [...(this.esperas.get(entidad) ?? []), r]); });
    this.enCurso.set(entidad, (this.enCurso.get(entidad) ?? 0) + 1);
    return () => { this.enCurso.set(entidad, (this.enCurso.get(entidad) ?? 1) - 1); const cola = this.esperas.get(entidad) ?? []; const sig = cola.shift(); this.esperas.set(entidad, cola); sig?.(); };
  }

  private async ejecutar(c: Clasificacion, asignaciones: Asignacion[], cwd: string): Promise<void> {
    const { almacen } = this.op;
    const perfil = perfilPorDefecto(this.op.perfiles.leer());
    const ejecuciones: Record<string, unknown>[] = [];
    let total = 0;
    for (const [i, st] of c.subtasks.entries()) {
      const a = asignaciones[i]!;
      const p = proveedor(a.proveedor)!;
      const max = perfil.entities.find((e) => e.id === a.entidad)?.max_concurrent ?? 1;
      const liberar = await this.turno(a.entidad ?? a.proveedor, max);
      const inicio = new Date().toISOString();
      const instruccion = `${c.original_prompt}\n\nSubtarea: ${st.name}\nValidación: ${st.validation}`;
      let r;
      try { r = await this.ejecutor(p, a.modelo, instruccion, { cwd, timeoutMs: TIMEOUT_MS }); } finally { liberar(); }
      total += r.latenciaMs;
      const estado = r.error ? 'failed' : 'completed';
      const tokensEntrada = Math.ceil(instruccion.length / 4), tokensSalida = Math.ceil(r.salida.length / 4);
      almacen.registrarRun({
        task_id: c.task_id, provider_name: p.nombre, routing_entity_id: a.entidad, routing_entity_name_snapshot: a.entidad_nombre, model_id: r.modelo, backend: 'cli', status: estado,
        started_at: inicio, completed_at: new Date().toISOString(), latency_ms: r.latenciaMs, input_tokens: tokensEntrada, output_tokens: tokensSalida, estimated_cost_usd: 0, error: r.error,
      });
      almacen.registrarDecision({ task_id: c.task_id, phase: 'delegate', decision: `${st.id}:${st.recommended_model}->cli:${p.nombre}`, score: st.complexity, backend: 'cli', reason: r.error ?? `executed '${st.name}'` });
      ejecuciones.push({
        subtask_id: st.id, status: estado, backend: 'cli', model_used: r.modelo, latency_ms: r.latenciaMs, estimated_cost_usd: 0, output: r.salida || (r.error ?? ''), error: r.error,
        input_tokens: tokensEntrada, output_tokens: tokensSalida, validation_iterations: 0, context_paths: [],
      });
    }
    const fallo = ejecuciones.some((e) => e['status'] === 'failed');
    almacen.actualizarTarea(c.task_id, fallo ? 'failed' : 'completed', {
      task_id: c.task_id, status: fallo ? 'failed' : 'completed', executions: ejecuciones, total_latency_ms: total, total_estimated_cost_usd: 0,
      total_input_tokens: ejecuciones.reduce((s, e) => s + Number(e['input_tokens']), 0), total_output_tokens: ejecuciones.reduce((s, e) => s + Number(e['output_tokens']), 0), completed_at: new Date().toISOString(),
    } as { total_estimated_cost_usd: number });
  }
}
