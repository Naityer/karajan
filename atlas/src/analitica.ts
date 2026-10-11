import { redondear } from './redondeo';

/**
 * Analítica de skills (puerto de `app/skill_analytics.py`): separa «recomendada» (la sugiere la clasificación o una subtarea)
 * de «ejecutada» (una subtarea que declara la skill y se ejecutó), sin tratar una recomendación como uso.
 */
export interface RegistroTarea {
  task_id: string;
  classification: {
    intent?: string; created_at: string; recommended_skills?: string[];
    subtasks?: { id: string; recommended_skill?: string | null }[];
  };
  delegation: null | {
    completed_at: string;
    executions: { subtask_id: string; status: string; model_used?: string; latency_ms?: number; estimated_cost_usd?: number }[];
  };
}
export type Run = Record<string, unknown>;

interface Instante { fecha: Date; micros: string }

/** `datetime.fromisoformat` + `_utc`: un valor sin zona horaria se toma como UTC. */
function instante(texto: string): Instante {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(texto.trim());
  if (!m) return { fecha: new Date(texto), micros: '' };
  const zona = !m[4] ? 'Z' : m[4] === 'Z' ? 'Z' : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
  const fecha = new Date(`${m[1]}T${m[2]}${m[3] ? `.${m[3].slice(0, 3).padEnd(3, '0')}` : ''}${zona}`);
  return { fecha, micros: (m[3] ?? '').padEnd(6, '0').slice(0, 6) };
}

/** `datetime.isoformat()` de un instante UTC: `…T…+00:00`, con microsegundos solo si no son cero. */
function isoPython(i: Instante): string {
  const base = i.fecha.toISOString().slice(0, 19);
  return `${base}${i.micros && Number(i.micros) !== 0 ? `.${i.micros}` : ''}+00:00`;
}

const minuscula = (s: string) => s.toLowerCase();
const porNombre = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function nombreAgente(run: Run | undefined, modelo: string): string {
  if (run) for (const k of ['routing_entity_name_snapshot', 'provider_name', 'model_id']) if (run[k]) return String(run[k]);
  return modelo || 'Agente sin identificar';
}

interface Fila {
  name: string; recomendadas: Set<string>; ejecutadas: Set<string>; ejecuciones: number; exitos: number; fallos: number;
  latencia: number; coste: number; agentes: Map<string, number>; tipos: Map<string, number>; ultima: Instante | null;
}

function ordenado(m: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1] || porNombre(minuscula(a[0]), minuscula(b[0]))));
}

export function construirAnaliticaSkills(
  registros: Iterable<RegistroTarea>,
  opciones: { runsPorTarea?: Record<string, Run[]>; skillsConocidas?: Iterable<string>; dias?: number; ahora?: Date } = {},
): Record<string, unknown> {
  const dias = opciones.dias ?? 30;
  const ahora = opciones.ahora ?? new Date();
  const corte = dias === 0 ? null : new Date(ahora.getTime() - dias * 86_400_000);
  const runsPorTarea = opciones.runsPorTarea ?? {};
  const filas = new Map<string, Fila>();
  const canonicos = new Map<string, string>();
  const porAgente = new Map<string, Map<string, number>>();
  const porTipo = new Map<string, Map<string, number>>();
  const linea = new Map<string, { executions: number; successes: number; skills: Map<string, number> }>();
  const tareasRecomendadas = new Set<string>();
  const tareasEjecutadas = new Set<string>();

  const fila = (nombre: string): Fila => {
    const candidato = nombre.trim();
    const plegado = candidato.toLowerCase();
    if (!canonicos.has(plegado)) canonicos.set(plegado, candidato);
    const clave = canonicos.get(plegado)!;
    if (!filas.has(clave)) filas.set(clave, { name: clave, recomendadas: new Set(), ejecutadas: new Set(), ejecuciones: 0, exitos: 0, fallos: 0, latencia: 0, coste: 0, agentes: new Map(), tipos: new Map(), ultima: null });
    return filas.get(clave)!;
  };
  const sumar = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const nombre of opciones.skillsConocidas ?? []) if (String(nombre).trim()) fila(String(nombre));

  for (const r of registros) {
    const c = r.classification;
    const tipo = c.intent || 'sin tipo';
    if (corte === null || instante(c.created_at).fecha >= corte) {
      const recomendadas = new Set(c.recommended_skills ?? []);
      for (const s of c.subtasks ?? []) if (s.recommended_skill) recomendadas.add(s.recommended_skill);
      for (const skill of recomendadas) { fila(skill).recomendadas.add(r.task_id); tareasRecomendadas.add(r.task_id); }
    }
    if (!r.delegation) continue;
    const ocurrio = instante(r.delegation.completed_at);
    if (corte !== null && ocurrio.fecha < corte) continue;
    const runs = runsPorTarea[r.task_id] ?? [];
    const subtareas = new Map((c.subtasks ?? []).map((s) => [s.id, s]));
    r.delegation.executions.forEach((ejecucion, i) => {
      const skill = subtareas.get(ejecucion.subtask_id)?.recommended_skill;
      if (!skill) return;
      const f = fila(skill);
      const agente = nombreAgente(runs[i], ejecucion.model_used ?? '');
      const exito = ejecucion.status === 'completed';
      const dia = ocurrio.fecha.toISOString().slice(0, 10);
      f.ejecutadas.add(r.task_id);
      f.ejecuciones++;
      if (exito) f.exitos++; else f.fallos++;
      f.latencia += Math.max(0, ejecucion.latency_ms ?? 0);
      f.coste += Math.max(0, ejecucion.estimated_cost_usd ?? 0);
      sumar(f.agentes, agente);
      sumar(f.tipos, tipo);
      if (!f.ultima || ocurrio.fecha > f.ultima.fecha) f.ultima = ocurrio;
      if (!porAgente.has(agente)) porAgente.set(agente, new Map());
      sumar(porAgente.get(agente)!, skill);
      if (!porTipo.has(tipo)) porTipo.set(tipo, new Map());
      sumar(porTipo.get(tipo)!, skill);
      if (!linea.has(dia)) linea.set(dia, { executions: 0, successes: 0, skills: new Map() });
      const l = linea.get(dia)!;
      l.executions++;
      l.successes += exito ? 1 : 0;
      sumar(l.skills, f.name);
      tareasEjecutadas.add(r.task_id);
    });
  }

  const skills = [...filas.values()].map((f) => ({
    name: f.name, recommended_tasks: f.recomendadas.size, executed_tasks: f.ejecutadas.size, executions: f.ejecuciones, successes: f.exitos, failures: f.fallos,
    success_rate: f.ejecuciones ? redondear(f.exitos / f.ejecuciones, 4) : null,
    avg_latency_ms: f.ejecuciones ? redondear(f.latencia / f.ejecuciones, 1) : null,
    total_cost_usd: redondear(f.coste, 6), agents: ordenado(f.agentes), task_types: ordenado(f.tipos),
    last_used_at: f.ultima ? isoPython(f.ultima) : null,
  }));
  skills.sort((a, b) => b.executions - a.executions || b.recommended_tasks - a.recommended_tasks || porNombre(minuscula(a.name), minuscula(b.name)));
  const ejecuciones = skills.reduce((s, x) => s + x.executions, 0);
  const exitos = skills.reduce((s, x) => s + x.successes, 0);
  const catalogo = filas.size;
  const activas = skills.filter((x) => x.executions > 0).length;

  const dimension = (fuente: Map<string, Map<string, number>>, clave: string) => [...fuente.entries()]
    .map(([nombre, valores]) => ({ [clave]: nombre, executions: [...valores.values()].reduce((s, v) => s + v, 0), skills: Object.fromEntries(valores) }))
    .sort((a, b) => (b['executions'] as number) - (a['executions'] as number) || porNombre(minuscula(a[clave] as string), minuscula(b[clave] as string)));

  return {
    period_days: dias,
    generated_at: `${ahora.toISOString().slice(0, 19)}+00:00`,
    summary: {
      catalog_skills: catalogo, recommended_tasks: tareasRecomendadas.size, executed_tasks: tareasEjecutadas.size, executions: ejecuciones, active_skills: activas,
      unused_skills: Math.max(0, catalogo - activas), successes: exitos, failures: ejecuciones - exitos,
      success_rate: ejecuciones ? redondear(exitos / ejecuciones, 4) : null,
      assignment_coverage: tareasRecomendadas.size ? redondear(tareasEjecutadas.size / tareasRecomendadas.size, 4) : null,
    },
    skills,
    by_agent: dimension(porAgente, 'agent'),
    by_task_type: dimension(porTipo, 'task_type'),
    timeline: [...linea.entries()].sort((a, b) => porNombre(a[0], b[0])).map(([date, v]) => ({
      date, executions: v.executions, successes: v.successes,
      skills: Object.fromEntries([...v.skills.entries()].sort((a, b) => porNombre(minuscula(a[0]), minuscula(b[0])))),
    })),
    definitions: {
      recommended: 'Skill sugerida por la clasificación o por una subtarea.',
      execution: 'Subtarea ejecutada que declara explícitamente una skill.',
      success_rate: 'Ejecuciones completadas / ejecuciones de la skill.',
      assignment_coverage: 'Tareas con una skill ejecutada / tareas con skills recomendadas.',
    },
  };
}
