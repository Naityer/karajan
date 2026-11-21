import { resolve as resolverRuta, sep } from 'node:path';

import type { Almacen } from './almacen';
import { clasificar, type Clasificacion, type Configuracion, type Subtarea } from './heuristica';
import { perfilPorDefecto, type Perfiles } from './perfiles';
import { disponibilidad, ejecutarProveedor, modeloPara, proveedor, type Disponibilidad, type Ejecutor, type Proveedor, type Tier } from './proveedores';
import { claudeExcedido, geminiDisponible, leerLimites, umbralClaude, type Limites } from './limites';
import { elegirRegla, nivelRegla, type Entidad, type Regla } from './reglas';
import { ranking, tareaDesdeClasificacion, type EntidadConFicha } from './puntuacion';
import { aislar, aislarActivo, cerrar, type Aislamiento } from './aislar-git';
import { destinoDe, type Rotador } from './rotador';
import { descubrirSkills, seleccionarSkills, type SkillDisponible } from './skills-seleccion';
import { componerSkills, elegirEspecialista, type ConfigEspecialistas, type EleccionEspecialista } from './especialistas';

/**
 * Delegación real desde el paquete: clasifica el prompt (heurística), elige el agente de cada subtarea con el perfil POR DEFECTO
 * (sus reglas por dominio y, si ninguna casa, sus niveles), ejecuta el CLI de ese agente y lo registra todo en `task_logs.db`
 * (tarea, decisiones y runs, con el esquema de Karajan). La ejecución va en segundo plano: `delegar` devuelve el plan enseguida y
 * el resultado se lee después con `/tasks/:id`, `/tasks/:id/runs` y `/tasks/:id/decisions`.
 */
const NIVEL_NOMBRE = ['level_1_simple', 'level_2_moderate', 'level_3_intermediate', 'level_4_complex', 'level_5_critical'];
const TIMEOUT_MS = 15 * 60_000;
/** Orden de respaldo cuando el agente elegido no está disponible en este equipo. */
const RESPALDO = ['codex', 'claude-cli', 'ollama-qwen', 'gemini-agy'];

/** La instrucción que recibe un agente: prompt, subtarea y, si las hay, las skills preparadas. La usa también la tutoría para examinar con la MISMA instrucción. */
export function construirInstruccion(prompt: string, st: Pick<Subtarea, 'name' | 'validation'>, preparadas: string[]): string {
  let instruccion = `${prompt}\n\nSubtarea: ${st.name}\nValidación: ${st.validation}`;
  if (preparadas.length) instruccion += `\n\nSkills preparadas para este agente, en orden: ${preparadas.join(', ')}. Consulta sus SKILL.md cuando correspondan.`;
  return instruccion;
}

export interface Asignacion { subtarea: string; nombre: string; entidad: string | null; entidad_nombre: string | null; proveedor: string; modelo: string; regla: string | null; motivo: string; /** Puntuación 0–100 con la que el perfil eligió a este agente (perfiles con fichas de aptitud). */ puntos?: number; /** % semanal de Claude si pasó a Codex por el límite. */ limite?: number; especialista?: EleccionEspecialista; base?: Asignacion; skills_sugeridas?: string[]; procedencias?: ReturnType<typeof componerSkills>['procedencias'] }
export interface Plan { task_id: string; status: string; clasificacion: Clasificacion; asignaciones: Asignacion[]; bloqueada: string | null }

interface Opciones {
  almacen: Almacen; perfiles: Perfiles; config: () => Configuracion; raiz: string;
  ejecutor?: Ejecutor; disponible?: (p: Proveedor) => Disponibilidad;
  /** Límites del plan (por defecto, el fichero que escribe Atlas dev). */
  limites?: () => Limites | null;
  /** Rotador de skills: repone la skill recomendada antes de ejecutar si estaba en el almacén. */
  rotador?: Rotador;
  skillsDisponibles?: () => SkillDisponible[];
  especialistas?: () => ConfigEspecialistas;
  /** Trabajar en un worktree con rama `agente/<task_id>` (por defecto, `KARAJAN_AISLAR_GIT=1`). */
  aislarGit?: boolean;
}

export class Delegador {
  private readonly ejecutor: Ejecutor;
  private readonly disponible: (p: Proveedor) => Disponibilidad;

  /** Disponible de verdad: la CLI está en el equipo y, para Gemini, su cuota semanal tiene margen con un dato reciente (nunca sin dato). */
  private puede(p: Proveedor): Disponibilidad {
    const d = this.disponible(p);
    if (!d.disponible || p.nombre !== 'gemini-agy') return d;
    if (geminiDisponible((this.op.limites ?? leerLimites)())) return d;
    return { ...d, disponible: false, motivo: 'cuota semanal de Gemini agotada, sin dato reciente o por encima del máximo' };
  }
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
  planificar(prompt: string, forzarEntidad?: string | null, especialista?: string | null): Plan {
    const c = clasificar(prompt, this.op.config());
    const catalogo = (this.op.skillsDisponibles ?? descubrirSkills)();
    const elegidas = seleccionarSkills(prompt, catalogo);
    c.recommended_skills = elegidas;
    c.subtasks.forEach((s, i) => {
      s.recommended_skills = i === 0 ? elegidas : [];
      s.recommended_skill = i === 0 ? (elegidas[0] ?? null) : null;
    });
    const asignaciones = c.subtasks.map((st) => this.asignar(c, st, forzarEntidad ?? null));
    // La primera subtarea recibe las skills, igual que en el selector anterior. Nunca cambia el proveedor del perfil.
    const a = asignaciones[0];
    if (a && this.op.especialistas && (!forzarEntidad || especialista)) try {
      const e = elegirEspecialista(prompt, a.proveedor, catalogo, this.op.especialistas(), especialista);
      if (e) {
        const union = componerSkills([], elegidas, e.skills);
        asignaciones[0] = { ...a, base: a, especialista: e, modelo: e.modelo, motivo: `${a.motivo}; ${e.motivo}`, skills_sugeridas: elegidas, procedencias: union.procedencias };
        c.recommended_skills = union.skills;
        c.subtasks[0]!.recommended_skills = union.skills;
        c.subtasks[0]!.recommended_skill = union.skills[0] ?? null;
      }
    } catch { /* el componente opcional nunca impide planificar */ }
    return { task_id: c.task_id, status: 'classified', clasificacion: c, asignaciones, bloqueada: null };
  }

  private asignar(c: Clasificacion, st: Subtarea, forzar: string | null): Asignacion {
    const perfil = perfilPorDefecto(this.op.perfiles.leer());
    const tier = st.recommended_model as Tier;
    const base = { subtarea: st.id, nombre: st.name };
    const conEntidad = (e: Entidad, regla: Regla | null, motivo: string): Asignacion | null => {
      const p = proveedor(e.provider);
      if (!p) return null;
      // Entidad por modelo: el modelo fijado en la entidad manda sobre el del nivel.
      const fijado = typeof e['model'] === 'string' && e['model'] ? (e['model'] as string) : null;
      return { ...base, entidad: e.id, entidad_nombre: e.name ?? e.id, proveedor: p.nombre, modelo: fijado ?? modeloPara(p, tier), regla: regla?.id ?? null, motivo };
    };
    if (forzar) {
      const e = perfil.entities.find((x) => x.id === forzar);
      const a = e && conEntidad(e, null, 'agente elegido a mano');
      if (!a) throw Object.assign(new Error(`El agente «${forzar}» no existe en el perfil por defecto o no se puede ejecutar desde el paquete`), { status: 422 });
      return a;
    }
    const m = elegirRegla(perfil, { dominios: c.domain, intencion: c.intent, nivel: nivelRegla(c.complexity_level, st.complexity), prompt: c.original_prompt });
    let a = m ? conEntidad(m.entidad, m.regla, `regla «${m.regla.name || m.regla.id}»`) : null;
    // Puntuación continua: con fichas de aptitud gana el agente (ejecutable aquí) que más puntúa.
    if (!a) {
      const nivelTarea = nivelRegla(c.complexity_level, 0);
      const tarea = tareaDesdeClasificacion(c.complexity_score, c.criteria as unknown as Record<string, number>, c.original_prompt, c.domain, 0.5 * (st.complexity - nivelTarea));
      for (const { entidad, puntos } of ranking(perfil.entities as EntidadConFicha[], tarea, (perfil as { scoring?: never }).scoring)) {
        const candidata = conEntidad(entidad, null, `puntuación ${puntos.toFixed(1)}/100`);
        if (candidata) { a = { ...candidata, puntos }; break; }
      }
    }
    if (!a) {
      // El nivel que manda es el de la tarea o el de la subtarea si es mayor (el mismo que ven las reglas).
      const n = nivelRegla(c.complexity_level, st.complexity);
      const nivel = NIVEL_NOMBRE[n - 1]!;
      const e = perfil.entities.find((x) => (x.levels ?? []).includes(nivel) && proveedor(x.provider)) ?? perfil.entities.find((x) => proveedor(x.provider));
      a = e ? conEntidad(e, null, `nivel ${n}`) : null;
    }
    // Si el agente elegido no puede ejecutarse aquí, el primero disponible del respaldo (queda anotado en el motivo).
    if (!a || !this.puede(proveedor(a.proveedor)!).disponible) {
      const motivo = a ? `${a.proveedor} no disponible (${this.puede(proveedor(a.proveedor)!).motivo})` : 'ningún agente del perfil se puede ejecutar';
      const respaldo = (st.recommended_skills?.length ?? 0) > 0 ? ['codex', 'claude-cli'] : RESPALDO;
      for (const nombre of respaldo) {
        const p = proveedor(nombre)!;
        if (!this.puede(p).disponible) continue;
        const e = perfil.entities.find((x) => x.provider === nombre);
        return { ...base, entidad: e?.id ?? null, entidad_nombre: e?.name ?? null, proveedor: nombre, modelo: modeloPara(p, tier), regla: null, motivo: `${motivo}; respaldo ${nombre}` };
      }
      if (a) return { ...a, motivo: `${motivo}; sin respaldo disponible` };
      return { ...base, entidad: null, entidad_nombre: null, proveedor: 'codex', modelo: 'default', regla: null, motivo };
    }
    if (a.proveedor === 'ollama-qwen' && (st.recommended_skills?.length ?? 0) > 0) {
      for (const nombre of ['codex', 'claude-cli']) {
        const p = proveedor(nombre)!;
        if (!this.puede(p).disponible) continue;
        const e = perfil.entities.find((x) => x.provider === nombre);
        return { ...base, entidad: e?.id ?? null, entidad_nombre: e?.name ?? nombre, proveedor: nombre,
          modelo: modeloPara(p, tier), regla: a.regla, motivo: `${a.motivo}; ${nombre} admite skills` };
      }
      return { ...a, motivo: `${a.motivo}; ningún agente compatible con skills está disponible` };
    }
    // Claude por encima de su umbral semanal: lo suyo pasa a Codex (salvo que se fuerce a mano, arriba) y se avisa.
    if (a.proveedor === 'claude-cli') {
      const pct = claudeExcedido((this.op.limites ?? leerLimites)());
      const codex = proveedor('codex');
      if (pct !== null && codex && this.puede(codex).disponible) {
        const e = perfil.entities.find((x) => x.provider === 'codex');
        return { ...base, entidad: e?.id ?? null, entidad_nombre: e?.name ?? 'Codex', proveedor: 'codex', modelo: modeloPara(codex, tier), regla: a.regla, limite: pct,
          motivo: `Claude al ${Math.round(pct)} % de su uso semanal (> ${umbralClaude()} %): pasa a Codex` };
      }
      // Sin Codex disponible, el desborde va a Gemini, solo si su cuota semanal tiene margen (ver `puede`).
      const gemini = proveedor('gemini-agy');
      if (pct !== null && gemini && this.puede(gemini).disponible) {
        const e = perfil.entities.find((x) => x.provider === 'gemini-agy');
        return { ...base, entidad: e?.id ?? null, entidad_nombre: e?.name ?? 'Gemini', proveedor: 'gemini-agy', modelo: modeloPara(gemini, tier), regla: a.regla, limite: pct,
          motivo: `Claude al ${Math.round(pct)} % de su uso semanal (> ${umbralClaude()} %) y sin Codex: pasa a Gemini (cuota sin coste)` };
      }
    }
    return a;
  }

  /** Clasifica, registra y lanza la ejecución en segundo plano. */
  delegar(prompt: string, { forzarEntidad = null, cwd, aprobada = false, entrada = null, especialista = null }: { forzarEntidad?: string | null; cwd?: unknown; aprobada?: boolean; entrada?: string | null; especialista?: string | null } = {}): Plan {
    const carpeta = this.carpeta(cwd);
    const plan = this.planificar(prompt, forzarEntidad, especialista);
    const c = plan.clasificacion;
    // Agente que recibió el prompt (punto de entrada), como `ClassificationResult.entry_agent` en Python.
    if (entrada) Object.assign(c, { entry_agent: entrada.slice(0, 60) });
    const { almacen } = this.op;
    almacen.guardarTarea(c, 'classified');
    almacen.registrarDecision({ task_id: c.task_id, phase: 'classify', decision: `model=${c.recommended_model}`, score: c.complexity_score, reason: c.reason });
    if (c.requires_human_review && !aprobada) {
      almacen.registrarDecision({ task_id: c.task_id, phase: 'validate', decision: 'human_review_gate=blocked', reason: 'La tarea exige revisión humana: vuelve a delegarla aprobándola.' });
      return { ...plan, bloqueada: 'La tarea exige revisión humana antes de ejecutarse.' };
    }
    for (const a of plan.asignaciones) {
      if (a.especialista) almacen.registrarDecision({ task_id: c.task_id, phase: 'assign', decision: `especialista:${a.especialista.id}`, reason: JSON.stringify({ modelo: a.modelo, procedencias: a.procedencias }) });
      almacen.registrarDecision({ task_id: c.task_id, phase: 'assign', decision: a.puntos !== undefined ? `score:${a.puntos.toFixed(1)}->${a.entidad}:${a.proveedor}` : a.regla ? `rule:${a.regla}->${a.entidad}:${a.proveedor}` : `${a.subtarea}->${a.entidad ?? '-'}:${a.proveedor}`, reason: a.motivo });
      if (a.limite !== undefined) almacen.registrarDecision({ task_id: c.task_id, phase: 'fallback', decision: 'limite_semanal:claude->codex', reason: a.motivo });
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

  private async ejecutar(c: Clasificacion, asignaciones: Asignacion[], carpeta: string): Promise<void> {
    const { almacen } = this.op;
    const perfil = perfilPorDefecto(this.op.perfiles.leer());
    const ejecuciones: Record<string, unknown>[] = [];
    let total = 0;
    // En el servidor cada tarea trabaja en su rama: main solo cambia con la integración nocturna.
    let ais: Aislamiento | null = null;
    if (this.op.aislarGit ?? aislarActivo()) {
      try { ais = aislar(carpeta, c.task_id); } catch (e) {
        almacen.registrarDecision({ task_id: c.task_id, phase: 'delegate', decision: 'git:aislar=error', reason: String((e as Error).message ?? e).slice(0, 500) });
      }
      if (ais) almacen.registrarDecision({ task_id: c.task_id, phase: 'delegate', decision: `git:rama=${ais.rama}`, reason: `worktree desde ${ais.base}` });
    }
    const cwd = ais?.carpeta ?? carpeta;
    for (const [i, st] of c.subtasks.entries()) {
      let a = asignaciones[i]!;
      const p = proveedor(a.proveedor)!;
      const max = perfil.entities.find((e) => e.id === a.entidad)?.max_concurrent ?? 1;
      const inicio = new Date().toISOString();
      // Skill recomendada: se deja instalada para el agente que ejecuta (desde el almacén si hace falta) y se le pide usarla.
      const destino = destinoDe(p.nombre);
      const preparadas: string[] = [];
      if (destino && this.op.rotador) for (const nombre of st.recommended_skills ?? (st.recommended_skill ? [st.recommended_skill] : [])) {
        let s;
        try { s = this.op.rotador.asegurar(nombre, destino); }
        catch (e) { s = { disponible: false, repuesta: false, motivo: `preparación fallida: ${(e as Error).message}` }; }
        if (s.disponible) preparadas.push(nombre);
        almacen.registrarDecision({ task_id: c.task_id, phase: 'delegate', decision: `skill:${s.disponible ? 'preparada' : 'no-disponible'}:${nombre}->${destino}`, reason: s.motivo });
        if (s.repuesta) almacen.registrarDecision({ task_id: c.task_id, phase: 'delegate', decision: `skill:repuesta:${nombre}->${destino}`, reason: s.motivo });
      }
      if (a.especialista && a.base && a.especialista.skills.some((n) => !preparadas.includes(n))) {
        almacen.registrarDecision({ task_id: c.task_id, phase: 'fallback', decision: `especialista:respaldo:${a.especialista.id}`, reason: 'No se preparó el paquete; conserva modelo y sugerencias originales.' });
        st.recommended_skills = a.skills_sugeridas ?? [];
        a = a.base;
        preparadas.splice(0, preparadas.length, ...preparadas.filter((n) => st.recommended_skills!.includes(n)));
      }
      const instruccion = construirInstruccion(c.original_prompt, st, preparadas);
      let r;
      const skillsRequeridas = st.recommended_skills ?? (st.recommended_skill ? [st.recommended_skill] : []);
      const liberar = await this.turno(a.entidad ?? a.proveedor, max);
      try {
        r = skillsRequeridas.some((nombre) => !preparadas.includes(nombre))
          ? { salida: '', error: 'No se pudieron preparar todas las skills recomendadas para el agente seleccionado.', latenciaMs: 0, modelo: a.modelo }
          : await this.ejecutor(p, a.modelo, `${a.especialista ? `Especialidad: ${a.especialista.nombre}. ${a.especialista.motivo}.\n\n` : ''}${instruccion}`, { cwd, timeoutMs: TIMEOUT_MS });
      } catch (e) {
        r = { salida: '', error: (e as Error).message, latenciaMs: 0, modelo: a.modelo };
      } finally { liberar(); }
      total += r.latenciaMs;
      const estado = r.error ? 'failed' : 'completed';
      const tokensEntrada = Math.ceil(instruccion.length / 4), tokensSalida = Math.ceil(r.salida.length / 4);
      almacen.registrarRun({
        task_id: c.task_id, provider_name: p.nombre, routing_entity_id: a.entidad, routing_entity_name_snapshot: a.entidad_nombre, model_id: r.modelo, backend: 'cli', status: estado,
        started_at: inicio, completed_at: new Date().toISOString(), latency_ms: r.latenciaMs, input_tokens: tokensEntrada, output_tokens: tokensSalida, estimated_cost_usd: 0, error: r.error, profile_id: perfil.id,
      });
      almacen.registrarDecision({ task_id: c.task_id, phase: 'delegate', decision: `${st.id}:${st.recommended_model}->cli:${p.nombre}`, score: st.complexity, backend: 'cli', reason: r.error ?? `executed '${st.name}'` });
      ejecuciones.push({
        subtask_id: st.id, status: estado, backend: 'cli', model_used: r.modelo, latency_ms: r.latenciaMs, estimated_cost_usd: 0, output: r.salida || (r.error ?? ''), error: r.error,
        input_tokens: tokensEntrada, output_tokens: tokensSalida, validation_iterations: 0, context_paths: [], prepared_skills: preparadas, used_skills: [],
        specialist: a.especialista?.id ?? null, skill_provenance: a.procedencias ?? [],
      });
    }
    const fallo = ejecuciones.some((e) => e['status'] === 'failed');
    if (ais) {
      const k = cerrar(ais, { mensaje: `karajan: ${c.original_prompt.replace(/\s+/g, ' ').trim()}` });
      almacen.registrarDecision({ task_id: c.task_id, phase: 'delegate', decision: k.commit ? `git:commit=${k.commit.slice(0, 12)};subida=${k.subida}` : 'git:sin-cambios', reason: k.error ?? ais.rama });
    }
    almacen.actualizarTarea(c.task_id, fallo ? 'failed' : 'completed', {
      task_id: c.task_id, status: fallo ? 'failed' : 'completed', executions: ejecuciones, total_latency_ms: total, total_estimated_cost_usd: 0,
      total_input_tokens: ejecuciones.reduce((s, e) => s + Number(e['input_tokens']), 0), total_output_tokens: ejecuciones.reduce((s, e) => s + Number(e['output_tokens']), 0), completed_at: new Date().toISOString(),
    } as { total_estimated_cost_usd: number });
  }
}
