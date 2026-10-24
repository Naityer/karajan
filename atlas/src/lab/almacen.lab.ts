import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Almacen } from '../almacen';
import type { Hallazgo } from '../pasarela-borradores';
import { proporcion, type ContextoLab, type Laboratorio, type Resultado } from '../laboratorio';

/**
 * Laboratorio del almacén: ¿se puede fiar del registro? Dos contratos, ninguno muta producción:
 *   integridad  (solo lectura sobre el `task_logs.db` real) runs y decisiones huérfanos, estados fuera del conjunto válido, fechas
 *               ilegibles o en orden inverso, índices de run repetidos y filas que la lectura se salta.
 *   ida-y-vuelta (en un `task_logs.db` temporal) lo que se escribe es lo que se lee: tarea, decisión, run, revisión y agregados.
 */
export interface ContextoAlmacen extends ContextoLab { almacen: Almacen }

/** Qué cuenta de la integridad es grave (rompe lecturas o cuentas) y cuál solo ensucia. */
const GRAVES: Record<string, string> = {
  decisiones_huerfanas: 'decisiones de tareas que no existen', runs_huerfanos: 'runs de tareas que no existen',
  tareas_estado_invalido: 'tareas con un estado desconocido', runs_estado_invalido: 'runs con un estado desconocido',
};
const LEVES: Record<string, string> = {
  tareas_fecha_incoherente: 'tareas con fechas ilegibles o actualizadas antes de crearse', runs_fecha_incoherente: 'runs con fechas ilegibles o terminados antes de empezar',
  runs_indice_repetido: 'tareas con dos runs del mismo índice', tareas_que_la_lectura_salta: 'tareas que el listado se salta por no cumplir el esquema',
};

function integridad(ctx: ContextoAlmacen): Resultado {
  const r = ctx.almacen.integridad();
  const hallazgos: Hallazgo[] = [];
  const graves = Object.entries(GRAVES).filter(([k]) => (r as Record<string, number>)[k]! > 0);
  const leves = Object.entries(LEVES).filter(([k]) => (r as Record<string, number>)[k]! > 0);
  if (graves.length) hallazgos.push({
    clave: 'registro-incoherente', severidad: 'alta', titulo: 'El registro de tareas tiene filas que no cuadran',
    evidencia: graves.map(([k, texto]) => `- ${(r as Record<string, number>)[k]} ${texto}`).join('\n'),
    propuesta: 'Localizar qué escritura las deja (delegar.ts · delegar/ejecutar, almacen.ts · registrar*) y limpiar las filas con una tarea aceptada; el laboratorio no las toca.',
  });
  if (leves.length) hallazgos.push({
    clave: 'registro-sucio', severidad: 'baja', titulo: 'El registro tiene filas con datos dudosos',
    evidencia: leves.map(([k, texto]) => `- ${(r as Record<string, number>)[k]} ${texto}`).join('\n'), propuesta: 'Revisar su origen; las tareas antiguas con backend «simulated» son esperables.',
  });
  return {
    muestra: r.tareas + r.runs + r.decisiones, suficiente: r.tareas > 0, hallazgos,
    metricas: { ...r, integridad: proporcion(r.tareas + r.runs + r.decisiones - graves.reduce((s, [k]) => s + (r as Record<string, number>)[k]!, 0), r.tareas + r.runs + r.decisiones) },
    umbrales: { huerfanas: '= 0', estados_invalidos: '= 0', fechas_incoherentes: 'solo aviso (baja)' },
  };
}

/** Escribe una tarea completa en un registro temporal y comprueba, campo a campo, que se lee lo mismo. */
function idaYVuelta(): Resultado {
  const dir = mkdtempSync(join(tmpdir(), 'karajan-lab-almacen-'));
  const fallos: string[] = [];
  let a: Almacen | null = null;
  try {
    a = new Almacen(join(dir, 'task_logs.db'));
    const clasificacion = { task_id: 'lab_1', original_prompt: 'prompt de laboratorio', created_at: '2026-01-02T03:04:05+00:00', complexity_level: 'level_2_moderate', recommended_model: 'medium_model', complexity_score: 2.25, requires_human_review: true, subtasks: [{ id: 's1' }, { id: 's2' }] };
    a.guardarTarea(clasificacion, 'classified');
    const delegacion = { completed_at: '2026-01-02T03:05:00+00:00', total_estimated_cost_usd: 0.5, executions: [{ subtask_id: 's1', status: 'completed', backend: 'cli', prepared_skills: ['pdf'], used_skills: [] }] };
    a.actualizarTarea('lab_1', 'completed', delegacion);
    a.registrarDecision({ task_id: 'lab_1', phase: 'assign', decision: 'agent=codex', score: 0.5, backend: 'cli', reason: 'prueba' });
    a.registrarRun({ task_id: 'lab_1', provider_name: 'codex', routing_entity_id: 'e1', routing_entity_name_snapshot: 'Codex', model_id: 'default', backend: 'cli', status: 'completed',
      started_at: '2026-01-02T03:04:10+00:00', completed_at: '2026-01-02T03:04:50+00:00', latency_ms: 40_000, input_tokens: 10, output_tokens: 20, estimated_cost_usd: 0.5, error: null });
    a.guardarRevision('lab_1', { skills_usadas: ['pdf'] }, '2026-01-02T04:00:00+00:00');
    const t = a.tarea('lab_1');
    const d = a.decisiones('lab_1'), runs = a.runs('lab_1');
    const m = a.metricas();
    const comprobar = (nombre: string, ok: boolean) => { if (!ok) fallos.push(nombre); };
    comprobar('tarea: estado', t?.status === 'completed');
    comprobar('tarea: prompt', t?.prompt === clasificacion.original_prompt);
    comprobar('tarea: clasificación', JSON.stringify(t?.classification) === JSON.stringify(clasificacion));
    comprobar('tarea: delegación', JSON.stringify(t?.delegation) === JSON.stringify(delegacion));
    comprobar('decisión', d.length === 1 && d[0]!['decision'] === 'agent=codex' && d[0]!['phase'] === 'assign' && d[0]!['reason'] === 'prueba');
    comprobar('run', runs.length === 1 && runs[0]!['provider_name'] === 'codex' && runs[0]!['latency_ms'] === 40_000 && runs[0]!['run_index'] === 0 && runs[0]!['error'] === null);
    comprobar('revisión', JSON.stringify(a.revisiones()) === JSON.stringify({ lab_1: { skills_usadas: ['pdf'] } }));
    comprobar('métricas', m.total_tasks === 1 && m.delegated_tasks === 1 && m.by_status['completed'] === 1 && m.by_level['level_2_moderate'] === 1 && m.total_estimated_cost_usd === 0.5);
    const plana = a.tareasPlanas()[0];
    comprobar('tarea plana', plana?.task_id === 'lab_1' && plana.runs?.length === 1 && plana.decisiones?.[0] === 'agent=codex' && plana.revision?.['skills_usadas']?.[0] === 'pdf');
    const i = a.integridad();
    comprobar('integridad del propio registro', i.decisiones_huerfanas + i.runs_huerfanos + i.tareas_estado_invalido + i.runs_estado_invalido + i.tareas_fecha_incoherente + i.runs_fecha_incoherente === 0);
  } catch (e) {
    fallos.push(`excepción: ${String((e as Error).message ?? e).slice(0, 200)}`);
  } finally {
    a?.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    muestra: 1, suficiente: true, metricas: { comprobaciones_fallidas: fallos.length }, umbrales: { comprobaciones_fallidas: '= 0' },
    hallazgos: fallos.length ? [{
      clave: 'ida-y-vuelta', severidad: 'alta', titulo: 'Lo que el almacén escribe no es lo que lee',
      evidencia: `En un task_logs.db temporal fallan: ${fallos.join('; ')}.`, propuesta: 'Revisar almacen.ts · guardarTarea, actualizarTarea, registrarDecision, registrarRun, guardarRevision y su lectura (listarTareas, runs, decisiones, tareasPlanas).',
    }] : [],
    detalle: { fallos },
  };
}

export const laboratorioAlmacen: Laboratorio<ContextoAlmacen> = {
  escenarios: [
    { id: 'integridad', tipo: 'contrato', descripcion: 'Solo lectura: runs y decisiones huérfanos, estados válidos y fechas coherentes del registro real', ejecutar: (c) => integridad(c) },
    { id: 'ida-y-vuelta', tipo: 'contrato', descripcion: 'En un task_logs.db temporal: escribir y leer da lo mismo (tarea, decisión, run, revisión, agregados)', ejecutar: () => idaYVuelta() },
  ],
};
