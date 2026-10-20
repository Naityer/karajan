import type { Hallazgo } from '../pasarela-borradores';
import { PESOS_SELECTOR, seleccionarSkills, type PesosSelector, type SkillDisponible } from '../skills-seleccion';
import type { ContextoLab, Laboratorio, Resultado } from '../laboratorio';

/**
 * Laboratorio del selector de skills (el ponderador por prompt). Se mide contra lo que la persona dio por bueno, en este orden
 * de fiabilidad: el sí/no de la fase «Preparando» (calibración), las skills usadas que se revisaron a mano y las skills que la
 * persona puso en la hoja de una tarea que no dejó en «auto». Con muestra suficiente calibra los pesos con validación cruzada y,
 * solo si mejoran en datos que no ha visto, los propone como borrador.
 */
export interface Caso { id: string; prompt: string; verdad: string[]; fuente: 'calibracion' | 'revision' | 'hoja' }
export interface ContextoSelector extends ContextoLab {
  skills(): SkillDisponible[];
  /** Tareas de Karajan con `skills_usadas` revisadas a mano (prompt + skills). */
  revisadas(): { id: string; prompt: string; skills: string[] }[];
}

export const UMBRALES_SELECTOR = { muestraMinima: 30, mejoraF1: 0.05, pliegues: 5, limite: 3 };

export async function casosDe(ctx: ContextoSelector): Promise<Caso[]> {
  const tareas = await ctx.tareas();
  const porHash = new Map(tareas.map((t) => [t.hash, t]));
  const casos = new Map<string, Caso>();
  for (const t of tareas) if (t.skillsHoja.length) casos.set(t.hash, { id: t.hash, prompt: t.prompt, verdad: t.skillsHoja, fuente: 'hoja' });
  for (const r of ctx.revisadas()) if (r.skills.length) casos.set(`k:${r.id}`, { id: `k:${r.id}`, prompt: r.prompt, verdad: r.skills, fuente: 'revision' });
  // La calibración manda: la última respuesta de cada tarea («sí» = lo propuesto; «no» = la corrección).
  for (const c of ctx.calibraciones('selector')) {
    const t = porHash.get(c.tarea_hash);
    const verdad = c.respuesta === 'si' ? c.propuesta : c.respuesta === 'no' ? c.correccion : [];
    if (t && verdad.length) casos.set(t.hash, { id: t.hash, prompt: t.prompt, verdad, fuente: 'calibracion' });
  }
  return [...casos.values()].sort((a, b) => a.id.localeCompare(b.id));
}

interface Medida { hit1: number; precision: number; recall: number; f1: number; falsos: number }
export function medir(casos: Caso[], catalogo: SkillDisponible[], pesos: PesosSelector, limite = UMBRALES_SELECTOR.limite): Medida {
  let hit1 = 0, precision = 0, recall = 0, f1 = 0, elegidasTot = 0, falsos = 0;
  for (const c of casos) {
    const elegidas = seleccionarSkills(c.prompt, catalogo, limite, pesos);
    const verdad = new Set(c.verdad);
    const aciertos = elegidas.filter((s) => verdad.has(s)).length;
    if (elegidas[0] && verdad.has(elegidas[0])) hit1++;
    const p = elegidas.length ? aciertos / elegidas.length : 0, r = verdad.size ? aciertos / verdad.size : 0;
    precision += p; recall += r; f1 += p + r ? (2 * p * r) / (p + r) : 0;
    elegidasTot += elegidas.length; falsos += elegidas.length - aciertos;
  }
  const n = casos.length || 1;
  return { hit1: hit1 / n, precision: precision / n, recall: recall / n, f1: f1 / n, falsos: elegidasTot ? falsos / elegidasTot : 0 };
}

/** Rejilla pequeña alrededor de los pesos actuales (los de explícita y alias por número de alias no se tocan). */
export function rejilla(): PesosSelector[] {
  const r: PesosSelector[] = [];
  for (const alias of [25, 35, 45]) for (const porNombre of [7, 11, 15]) for (const porDescripcion of [1, 2, 3, 4]) for (const umbral of [10, 15, 20, 25]) {
    r.push({ ...PESOS_SELECTOR, alias, porNombre, porDescripcion, umbral });
  }
  return r;
}

/** Los pesos de la rejilla con mejor F1 en esos casos (a igualdad, los actuales). */
function mejores(casos: Caso[], catalogo: SkillDisponible[]): PesosSelector {
  let mejor: PesosSelector = PESOS_SELECTOR, f1 = medir(casos, catalogo, PESOS_SELECTOR).f1;
  for (const p of rejilla()) { const m = medir(casos, catalogo, p).f1; if (m > f1) { mejor = p; f1 = m; } }
  return mejor;
}

/** Validación cruzada: en cada pliegue se eligen los pesos con el resto y se miden en ese pliegue. */
export function calibrar(casos: Caso[], catalogo: SkillDisponible[], pliegues = UMBRALES_SELECTOR.pliegues) {
  let f1Actual = 0, f1Calibrado = 0, hitActual = 0, hitCalibrado = 0;
  for (let k = 0; k < pliegues; k++) {
    const prueba = casos.filter((_, i) => i % pliegues === k), entreno = casos.filter((_, i) => i % pliegues !== k);
    if (!prueba.length) continue;
    const a = medir(prueba, catalogo, PESOS_SELECTOR), b = medir(prueba, catalogo, mejores(entreno, catalogo));
    f1Actual += a.f1 * prueba.length; f1Calibrado += b.f1 * prueba.length; hitActual += a.hit1 * prueba.length; hitCalibrado += b.hit1 * prueba.length;
  }
  const n = casos.length || 1;
  return { f1Actual: f1Actual / n, f1Calibrado: f1Calibrado / n, hitActual: hitActual / n, hitCalibrado: hitCalibrado / n, pesos: mejores(casos, catalogo) };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export const laboratorioSelector: Laboratorio<ContextoSelector> = {
  escenarios: [
    {
      id: 'explicitas', tipo: 'contrato', descripcion: 'Toda skill instalada sale si se nombra en el prompt; las que no tienen descripción solo pueden salir así',
      ejecutar: (ctx) => {
        const cat = ctx.skills();
        const fallan = cat.filter((s) => !seleccionarSkills(`usa la skill ${s.name} para esto`, cat, 10).includes(s.name)).map((s) => s.name);
        const mudas = cat.filter((s) => !s.description.trim()).map((s) => s.name);
        const hallazgos: Hallazgo[] = [];
        if (fallan.length) hallazgos.push({ clave: 'explicitas-no-seleccionables', severidad: 'media', titulo: `Skills que no salen ni nombrándolas: ${fallan.slice(0, 8).join(', ')}${fallan.length > 8 ? '…' : ''}`, evidencia: `${fallan.length} de ${cat.length} skills no aparecen al pedir «usa la skill <nombre>».`, propuesta: 'Revisar la normalización del nombre en `contiene` de `skills-seleccion.ts`.' });
        if (mudas.length) hallazgos.push({ clave: 'skills-sin-descripcion', severidad: 'baja', titulo: `Skills sin descripción (el ponderador no puede elegirlas por el prompt): ${mudas.slice(0, 8).join(', ')}`, evidencia: `${mudas.length} skills sin \`description:\` en su SKILL.md.`, propuesta: 'Completar la descripción o candidatas para el curador.' });
        return { muestra: cat.length, suficiente: cat.length > 0, hallazgos, metricas: { skills: cat.length, no_seleccionables: fallan.length, sin_descripcion: mudas.length }, umbrales: { no_seleccionables: '= 0' } };
      },
    },
    {
      id: 'concordancia', tipo: 'replay', descripcion: 'A ciegas: las skills que elegiría Karajan frente a las que la persona dio por buenas',
      ejecutar: async (ctx): Promise<Resultado> => {
        const casos = await casosDe(ctx);
        const m = medir(casos, ctx.skills(), PESOS_SELECTOR);
        const fuentes: Record<string, number> = {};
        for (const c of casos) fuentes[c.fuente] = (fuentes[c.fuente] ?? 0) + 1;
        return {
          muestra: casos.length, suficiente: casos.length >= UMBRALES_SELECTOR.muestraMinima, hallazgos: [],
          metricas: casos.length ? { hit1: r3(m.hit1), precision3: r3(m.precision), recall3: r3(m.recall), f1: r3(m.f1), falsos_positivos: r3(m.falsos) } : { hit1: null, precision3: null, recall3: null, f1: null, falsos_positivos: null },
          umbrales: { muestra: `≥ ${UMBRALES_SELECTOR.muestraMinima} casos con verdad humana` }, detalle: { fuentes },
        };
      },
    },
    {
      id: 'calibracion', tipo: 'feedback', descripcion: 'Busca pesos mejores con validación cruzada; solo los propone si mejoran en datos no vistos',
      ejecutar: async (ctx): Promise<Resultado> => {
        const casos = await casosDe(ctx);
        const U = UMBRALES_SELECTOR;
        if (casos.length < U.muestraMinima) return { muestra: casos.length, suficiente: false, hallazgos: [], metricas: { f1_actual: null, f1_calibrado: null }, umbrales: { muestra: `≥ ${U.muestraMinima}` } };
        const c = calibrar(casos, ctx.skills());
        const mejora = c.f1Calibrado - c.f1Actual;
        const hallazgos: Hallazgo[] = mejora >= U.mejoraF1 && c.hitCalibrado >= c.hitActual ? [{
          clave: 'pesos-selector', severidad: 'media', titulo: `Pesos del selector de skills: +${(mejora * 100).toFixed(1)} pp de F1 en validación cruzada`,
          evidencia: `${casos.length} casos con verdad humana, ${U.pliegues} pliegues. F1 ${c.f1Actual.toFixed(3)} → ${c.f1Calibrado.toFixed(3)}; Hit@1 ${c.hitActual.toFixed(3)} → ${c.hitCalibrado.toFixed(3)}.`,
          propuesta: `Cambiar \`PESOS_SELECTOR\` en \`atlas/src/skills-seleccion.ts\` a:\n\n\`\`\`json\n${JSON.stringify(c.pesos, null, 2)}\n\`\`\``,
          criterios: ['Los tests de `skills-seleccion` siguen en verde (ajustar los que fijan el comportamiento antiguo solo si la persona lo acepta).', '`kj lab run selector` da la mejora anunciada.'],
        }] : [];
        return { muestra: casos.length, suficiente: true, hallazgos, metricas: { f1_actual: r3(c.f1Actual), f1_calibrado: r3(c.f1Calibrado), hit1_actual: r3(c.hitActual), hit1_calibrado: r3(c.hitCalibrado), mejora_f1: r3(mejora) }, umbrales: { mejora_f1: `≥ ${U.mejoraF1}`, hit1: 'no empeora' }, detalle: { pesos_propuestos: c.pesos } };
      },
    },
  ],
};
