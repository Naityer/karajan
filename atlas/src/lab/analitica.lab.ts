import { construirAnaliticaSkills, type RegistroTarea, type Run } from '../analitica';
import type { Hallazgo } from '../pasarela-borradores';
import type { ContextoLab, Laboratorio, Resultado } from '../laboratorio';

/**
 * Laboratorio de la analítica de skills: ¿las cuentas son coherentes consigo mismas y con el almacén? Solo lectura, sobre todo el
 * histórico (`dias: 0`) y sin las skills revisadas a mano (que cuentan como uso sin preparación y falsearían la comparación):
 *   por skill   usadas ≤ preparadas (un uso necesita una preparación); preparadas ≤ recomendadas cuando la skill se recomendó
 *               alguna vez (lo contrario es normal: la elige el selector, no la clasificación, y solo se avisa).
 *   totales     ejecuciones = Σ por skill = Σ de la línea de tiempo; éxitos + fallos = ejecuciones; las tareas con ejecución no superan
 *               las delegadas ni las que cuenta el almacén.
 */
export interface ContextoAnalitica extends ContextoLab {
  /** Tareas del registro tal como las lee el almacén (`listarTareas`). */
  registros(): RegistroTarea[];
  runsPorTarea(): Record<string, Run[]>;
  /** Los agregados del almacén para el cruce (`metricas()`). */
  metricas(): { total_tasks: number; delegated_tasks: number };
}

interface FilaSkill { name: string; recommended_tasks: number; prepared_tasks: number; executed_tasks: number; executions: number; successes: number; failures: number }
interface Resumen { recommended_tasks: number; executed_tasks: number; executions: number; successes: number; failures: number; preparations: number }

function coherencia(ctx: ContextoAnalitica): Resultado {
  const registros = ctx.registros();
  const a = construirAnaliticaSkills(registros, { runsPorTarea: ctx.runsPorTarea(), dias: 0 }) as { summary: Resumen; skills: FilaSkill[]; timeline: { executions: number }[] };
  const { summary: s, skills } = a;
  const m = ctx.metricas();
  const usadasDePreparadas = skills.filter((k) => k.executed_tasks > k.prepared_tasks).map((k) => k.name);
  const preparadasSinRecomendar = skills.filter((k) => k.recommended_tasks > 0 && k.prepared_tasks > k.recommended_tasks).map((k) => k.name);
  const delegadas = registros.filter((r) => r.delegation).length;
  const totales: string[] = [];
  const cuadra = (texto: string, ok: boolean) => { if (!ok) totales.push(texto); };
  cuadra(`ejecuciones ${s.executions} ≠ Σ por skill ${skills.reduce((x, k) => x + k.executions, 0)}`, s.executions === skills.reduce((x, k) => x + k.executions, 0));
  cuadra(`ejecuciones ${s.executions} ≠ Σ línea de tiempo ${a.timeline.reduce((x, d) => x + d.executions, 0)}`, s.executions === a.timeline.reduce((x, d) => x + d.executions, 0));
  cuadra(`éxitos ${s.successes} + fallos ${s.failures} ≠ ejecuciones ${s.executions}`, s.successes + s.failures === s.executions);
  cuadra(`tareas con ejecución ${s.executed_tasks} > tareas delegadas ${delegadas}`, s.executed_tasks <= delegadas);
  cuadra(`tareas delegadas leídas ${delegadas} > las del almacén ${m.delegated_tasks}`, delegadas <= m.delegated_tasks);
  cuadra(`tareas leídas ${registros.length} > las del almacén ${m.total_tasks}`, registros.length <= m.total_tasks);
  cuadra(`tareas con recomendación ${s.recommended_tasks} > tareas leídas ${registros.length}`, s.recommended_tasks <= registros.length);
  const hallazgos: Hallazgo[] = [];
  if (usadasDePreparadas.length) hallazgos.push({
    clave: 'usadas-sin-preparar', severidad: 'media', titulo: `${usadasDePreparadas.length} skills con más tareas usadas que preparadas`,
    evidencia: `Un uso confirmado sin preparación previa no debería existir: ${usadasDePreparadas.slice(0, 20).join(', ')}.`, propuesta: 'Revisar cómo `delegar.ts` rellena `prepared_skills` y `used_skills` y cómo las cuenta `construirAnaliticaSkills`.',
  });
  if (totales.length) hallazgos.push({
    clave: 'totales-no-cuadran', severidad: 'alta', titulo: 'Los totales de la analítica no cuadran',
    evidencia: totales.map((t) => `- ${t}`).join('\n'), propuesta: 'Revisar las sumas de `construirAnaliticaSkills` en `atlas/src/analitica.ts` frente a las agregaciones del almacén.',
  });
  if (preparadasSinRecomendar.length) hallazgos.push({
    clave: 'preparadas-sin-recomendar', severidad: 'baja', titulo: `${preparadasSinRecomendar.length} skills se preparan en más tareas de las que se recomiendan`,
    evidencia: `Lo eligió el selector o la persona, no la clasificación: ${preparadasSinRecomendar.slice(0, 20).join(', ')}.`, propuesta: 'Aviso: la «cobertura» de la analítica solo mide lo recomendado.',
  });
  return {
    muestra: registros.length, suficiente: registros.length > 0, hallazgos,
    metricas: { tareas: registros.length, skills: skills.length, ejecuciones: s.executions, preparaciones: s.preparations, usadas_sin_preparar: usadasDePreparadas.length, totales_que_no_cuadran: totales.length, preparadas_sin_recomendar: preparadasSinRecomendar.length },
    umbrales: { usadas_sin_preparar: '= 0', totales_que_no_cuadran: '= 0' }, detalle: { totales_que_no_cuadran: totales },
  };
}

export const laboratorioAnalitica: Laboratorio<ContextoAnalitica> = {
  escenarios: [
    { id: 'coherencia', tipo: 'contrato', descripcion: 'Solo lectura: recomendadas / preparadas / usadas por skill y totales que cuadran con el almacén', ejecutar: (c) => coherencia(c) },
  ],
};
