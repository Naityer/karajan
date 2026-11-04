import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { construirInstruccion } from './delegar';
import { etiquetaForjada, type SkillForjada } from './skillforge';
import { disponibilidad, modeloPara, proveedor, type Ejecutor, type Proveedor } from './proveedores';
import type { Eleccion } from './tutor';
import { calificar, extraerJson, ficherosDeDiff, filtrarPista, solape, UMBRALES_TUTORIA, type ExamenAnonimo, type Veredicto } from './tutoria-nota';

/**
 * La tutoría examina a un agente local con tareas que YA se hicieron bien. Una tarea integrada deja en git el commit con el
 * trailer `Karajan-Tarea: <id>`: ese commit es la respuesta registrada como correcta. El alumno recibe la MISMA instrucción que
 * recibió el agente de producción, en un worktree temporal del repo en el estado justo anterior a esa integración; si se atasca
 * (error de ejecución, permisos, skill sin instalar), un tutor lo desbloquea SIN ver la referencia y sin dar la solución; al final
 * el tutor compara lo que hizo el alumno con la referencia y la nota sale de `tutoria-nota.ts`.
 * Nada de esto toca los repos ni las skills reales: el worktree vive en un temporal y se borra al terminar, sin ramas ni commits.
 */
export interface Referencia { repo: string; base: string; ultimo: string; diff: string; ficheros: string[] }
export interface PlanTarea { dominio: string; nivel: number; subtareas: { nombre: string; validacion: string; skills: string[] }[] }
export interface Agente { proveedor: Proveedor; modelo: string }

export interface PuertosExamen {
  ejecutor: Ejecutor;
  /** Qué haría el delegador con este prompt: nivel, dominio, subtareas y skills recomendadas. */
  planificar(prompt: string, skillsHoja?: string[]): PlanTarea;
  /** Skills que el alumno tiene ya instaladas (vacío si su proveedor no admite skills). */
  instaladas(): Set<string>;
  /** El SKILL.md de una skill del equipo (instalada o en el almacén), o null. */
  textoSkill(nombre: string): string | null;
  ahora?: () => Date;
}

/** Por encima de esto, la referencia o la respuesta se recortan para el tutor. */
export const MAX_DIFF = 60_000;
const MAX_PARA_TUTOR = 20_000;
const TIMEOUT_ALUMNO = 15 * 60_000, TIMEOUT_TUTOR = 5 * 60_000;

const git = (cwd: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, salida: (r.stdout ?? '').toString().trim(), error: ((r.stderr ?? '').toString().trim() || r.error?.message) ?? '' };
};

/** Repos git en `raiz` (ella misma, si lo es, y sus carpetas directas). */
export function listarRepos(raiz: string): string[] {
  const es = (d: string) => existsSync(join(d, '.git'));
  const hijos = (() => { try { return readdirSync(raiz, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => join(raiz, e.name)); } catch { return []; } })();
  return [raiz, ...hijos].filter(es);
}

/**
 * La referencia de una tarea: los commits con su trailer que ya están en `main`. Null si no hay (aún no se integró, o no cambió
 * nada), si empieza en el commit raíz o si el diff pasa de `MAX_DIFF` (no cabe en el prompt del tutor).
 */
export function buscarReferencia(repos: string[], taskId: string): Referencia | null {
  if (!/^[\w-]+$/.test(taskId)) return null;
  for (const repo of repos) {
    const rama = ['main', 'origin/main'].find((r) => git(repo, ['rev-parse', '--verify', '--quiet', r]).ok);
    if (!rama) continue;
    const commits = git(repo, ['log', rama, '--reverse', '--format=%H', '-E', `--grep=^Karajan-Tarea: ${taskId}$`]).salida.split(/\s+/).filter(Boolean);
    if (!commits.length) continue;
    const base = `${commits[0]}^`;
    if (!git(repo, ['rev-parse', '--verify', '--quiet', base]).ok) continue;
    const ultimo = commits[commits.length - 1]!;
    const d = git(repo, ['diff', '--no-color', base, ultimo]);
    if (!d.ok || !d.salida || d.salida.length > MAX_DIFF) continue;
    return { repo, base: git(repo, ['rev-parse', base]).salida, ultimo, diff: d.salida, ficheros: ficherosDeDiff(d.salida) };
  }
  return null;
}

/** Clase del obstáculo según el mensaje de error: lo que el tutor ve y lo que el informe agrupa. */
export function clasificarObstaculo(error: string): string {
  if (/tiempo agotado/i.test(error)) return 'tiempo';
  if (/permission|denied|eacces|eperm|not permitted|permiso/i.test(error)) return 'permisos';
  if (/skill/i.test(error)) return 'skill';
  if (/not recognized|command not found|enoent|no se reconoce|no está en el path/i.test(error)) return 'comando';
  return 'otro';
}

const recorte = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}\n[… recortado]` : t);

function promptTutor(tarea: string, obstaculo: string, detalle: string, faltan: string[], previas: string[]): string {
  return [
    'Eres el TUTOR de un agente alumno que intenta resolver una tarea real de software. Tu único trabajo es desbloquearlo cuando algo del entorno o del método le impide avanzar.',
    'NO resuelves la tarea. NO escribes código de la solución, ni dices qué fichero hay que cambiar ni cómo. Una pista orienta (qué mirar, qué probar, cómo leer un error), nunca entrega la respuesta.',
    `\nTarea del alumno:\n${recorte(tarea, 3000)}`,
    `\nObstáculo (${obstaculo}):\n${recorte(detalle, 1500)}`,
    faltan.length ? `\nSkills que la tarea pedía y el alumno no tiene instaladas: ${faltan.join(', ')}.` : '',
    previas.length ? `\nPistas que ya diste (no las repitas):\n- ${previas.join('\n- ')}` : '',
    '\nResponde SOLO con un objeto JSON, sin texto alrededor:',
    '{"accion":"pista"|"instalar_skill"|"ninguna","texto":"pista de menos de 500 caracteres y sin código","skill":"nombre, solo con instalar_skill y de la lista de arriba"}',
  ].filter(Boolean).join('\n');
}

function promptEvaluador(tarea: string, ref: Referencia, trabajo: string, salida: string, ayudas: number): string {
  return [
    'Eres el TUTOR y ahora evalúas. Un agente alumno ha intentado una tarea; tienes la solución que ya se integró y se registró como correcta.',
    `\nTarea:\n${recorte(tarea, 3000)}`,
    `\nSOLUCIÓN REGISTRADA COMO CORRECTA (diff):\n${recorte(ref.diff, MAX_PARA_TUTOR)}`,
    `\nTRABAJO DEL ALUMNO (cambios en el repo):\n${trabajo ? recorte(trabajo, MAX_PARA_TUTOR) : '(no cambió ningún fichero)'}`,
    salida ? `\nRESPUESTA DE TEXTO DEL ALUMNO:\n${recorte(salida, 6000)}` : '',
    `\nEl alumno necesitó ${ayudas} ayuda(s) tuya(s). Una solución distinta pero que cumple lo pedido y no rompe nada es válida: compara el efecto, no el texto.`,
    '\nResponde SOLO con JSON: {"cumple":0-100,"equivalencia":0-100,"regresiones":true|false,"motivo":"una frase"}',
    'cumple = cuánto de lo pedido consigue; equivalencia = cuánto se parece su efecto al de la solución registrada; regresiones = rompe algo que funcionaba.',
  ].filter(Boolean).join('\n');
}

/** El proveedor del tutor con el modelo elegido puesto en su línea de comandos (el de Codex no lo lleva de serie). */
export function agenteTutor(e: Eleccion | null): Agente | null {
  const p = e && proveedor(e.proveedor);
  if (!e || !p) return null;
  return { proveedor: p.nombre === 'codex' ? { ...p, args: (m: string) => ['exec', '--model', m, '--ephemeral', '--color', 'never', '--skip-git-repo-check', '-'] } : p, modelo: e.modelo };
}

/** El alumno: el proveedor local (por defecto Qwen con ollama) con su modelo, o por qué no se puede examinar. */
export function agenteAlumno(nombre = process.env['KARAJAN_ALUMNO'] || 'ollama-qwen', modelo = process.env['KARAJAN_ALUMNO_MODELO'] || null): { agente: Agente } | { motivo: string } {
  const p = proveedor(nombre);
  if (!p) return { motivo: `«${nombre}» no es un proveedor conocido` };
  const d = disponibilidad(p);
  if (!d.disponible) return { motivo: d.motivo ?? 'no disponible' };
  return { agente: { proveedor: p, modelo: modelo ?? p.modeloLocal ?? modeloPara(p, 'cheap_model') } };
}

export interface ResultadoExamen { examen: ExamenAnonimo; veredicto: Veredicto | null }

/** Examina a `alumno` con una tarea. Nunca lanza: un fallo del propio examen deja la nota a null y dice por qué. */
export async function examinar(x: { hash: string; prompt: string; referencia: Referencia; alumno: Agente; tutor: Agente; skillsHoja?: string[]; /** Skills de SkillForge de este dominio: el alumno las recibe en su prompt y el examen es de «con skill». */ forjadas?: SkillForjada[] }, p: PuertosExamen): Promise<ResultadoExamen> {
  const inicio = Date.now();
  const fecha = (p.ahora ?? (() => new Date()))().toISOString();
  const plan = p.planificar(x.prompt, x.skillsHoja);
  const base: Omit<ExamenAnonimo, 'nota' | 'ayudas' | 'ayudasRechazadas' | 'ms' | 'motivo' | 'obstaculos' | 'forjadas'> = {
    tarea: x.hash, dominio: plan.dominio, nivel: plan.nivel, alumno: `${x.alumno.proveedor.nombre}/${x.alumno.modelo}`, tutor: `${x.tutor.proveedor.nombre}/${x.tutor.modelo}`, fecha,
  };
  const cierre = (nota: number | null, motivo: string, ayudas: number, rechazadas: number, obstaculos: string[], veredicto: Veredicto | null): ResultadoExamen =>
    ({ examen: { ...base, nota, ayudas, ayudasRechazadas: rechazadas, ms: Date.now() - inicio, motivo: motivo.slice(0, 300), obstaculos, ...(x.forjadas?.length ? { forjadas: x.forjadas.map(etiquetaForjada) } : {}) }, veredicto });

  const dir = mkdtempSync(join(tmpdir(), 'kj-tutoria-'));
  const sandbox = join(dir, 'trabajo');
  let creado = false;
  try {
    const w = git(x.referencia.repo, ['worktree', 'add', '--detach', sandbox, x.referencia.base]);
    if (!w.ok) return cierre(null, `no se pudo preparar el sandbox: ${w.error}`, 0, 0, [], null);
    creado = true;

    let ayudas = 0, rechazadas = 0, salida = '', ultimoError: string | null = null;
    const obstaculos: string[] = [], pistas: string[] = [], extras: string[] = [];
    const instaladas = p.instaladas();
    for (const st of plan.subtareas) {
      for (;;) {
        const faltan = st.skills.filter((s) => !instaladas.has(s) && !extras.includes(s));
        const preparadas = st.skills.filter((s) => instaladas.has(s) || extras.includes(s));
        let instruccion = construirInstruccion(x.prompt, { name: st.nombre, validation: st.validacion }, preparadas);
        for (const s of extras) { const t = p.textoSkill(s); if (t) instruccion += `\n\nSkill ${s} (SKILL.md):\n${recorte(t, 6000)}`; }
        // Skills validadas por SkillForge para este alumno: van como texto en el prompt, sin instalarlas en ningún sitio.
        for (const f of x.forjadas ?? []) instruccion += `\n\nSkill ${f.id} (SKILL.md):\n${recorte(f.instrucciones, 6000)}`;
        if (pistas.length) instruccion += `\n\nPistas del tutor:\n- ${pistas.join('\n- ')}`;
        // Sin las skills que pedía, producción falla antes de ejecutar: aquí es un obstáculo como otro.
        const r = faltan.length ? { salida: '', error: `Skills no instaladas para el agente: ${faltan.join(', ')}`, latenciaMs: 0, modelo: x.alumno.modelo }
          : await p.ejecutor(x.alumno.proveedor, x.alumno.modelo, instruccion, { cwd: sandbox, timeoutMs: TIMEOUT_ALUMNO });
        salida = r.salida || salida;
        ultimoError = r.error;
        if (!r.error) break;
        const clase = clasificarObstaculo(r.error);
        obstaculos.push(clase);
        if (ayudas + rechazadas >= UMBRALES_TUTORIA.maxAyudas) break;
        const t = await p.ejecutor(x.tutor.proveedor, x.tutor.modelo, promptTutor(x.prompt, clase, r.error, faltan, pistas), { cwd: dir, timeoutMs: TIMEOUT_TUTOR });
        const j = t.error ? null : extraerJson<{ accion?: string; texto?: string; skill?: string }>(t.salida);
        if (!j || j.accion === 'ninguna' || !j.accion) { rechazadas++; continue; }
        if (j.accion === 'instalar_skill' && j.skill && faltan.includes(j.skill) && p.textoSkill(j.skill)) { extras.push(j.skill); ayudas++; continue; }
        // La referencia no se le enseña al tutor; el filtro cubre el caso de que acierte o recite una línea de la solución.
        const f = j.accion === 'pista' ? filtrarPista(String(j.texto ?? ''), x.referencia.diff) : { ok: false, motivo: 'acción no permitida' };
        if (f.ok) { pistas.push(String(j.texto).trim()); ayudas++; } else rechazadas++;
      }
    }

    git(sandbox, ['add', '-A']);
    const trabajo = git(sandbox, ['diff', '--cached', '--no-color']).salida;
    const hizoAlgo = trabajo.length > 0 || (salida.length > 0 && !ultimoError);
    if (!hizoAlgo) return cierre(0, ultimoError ? `el alumno no llegó a producir nada: ${ultimoError}` : 'el alumno no produjo cambios ni respuesta', ayudas, rechazadas, obstaculos, null);

    const e = await p.ejecutor(x.tutor.proveedor, x.tutor.modelo, promptEvaluador(x.prompt, x.referencia, trabajo, trabajo ? '' : salida, ayudas), { cwd: dir, timeoutMs: TIMEOUT_TUTOR });
    const j = e.error ? null : extraerJson<Partial<Veredicto>>(e.salida);
    if (!j || typeof j.cumple !== 'number' || typeof j.equivalencia !== 'number') return cierre(null, `sin veredicto del tutor: ${e.error ?? 'respuesta sin el JSON esperado'}`, ayudas, rechazadas, obstaculos, null);
    const veredicto: Veredicto = { cumple: j.cumple, equivalencia: j.equivalencia, regresiones: j.regresiones === true, motivo: String(j.motivo ?? '') };
    const s = solape(x.referencia.ficheros, ficherosDeDiff(trabajo), trabajo ? '' : salida);
    return cierre(calificar({ veredicto, solape: s, ayudas, hizoAlgo }), veredicto.motivo, ayudas, rechazadas, obstaculos, veredicto);
  } catch (err) {
    return cierre(null, `fallo del examen: ${String((err as Error).message ?? err)}`, 0, 0, [], null);
  } finally {
    if (creado) { git(x.referencia.repo, ['worktree', 'remove', '--force', sandbox]); git(x.referencia.repo, ['worktree', 'prune']); }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* lo borra el sistema */ }
  }
}
