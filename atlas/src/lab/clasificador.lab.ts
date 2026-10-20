import type { Clasificacion } from '../heuristica';
import type { Hallazgo } from '../pasarela-borradores';
import { proporcion, wilson, type ContextoLab, type Laboratorio } from '../laboratorio';

/**
 * Laboratorio del clasificador heurístico: a ciegas frente a la clasificación que la persona anota en la hoja de la tarea
 * (`nivel_tarea`, `dominio`). Si con muestra suficiente el nivel no coincide ni en la mitad de los casos, se propone revisarlo.
 */
export interface ContextoClasificador extends ContextoLab { clasificar(prompt: string): Clasificacion }

export const UMBRALES_CLASIFICADOR = { muestraMinima: 20, nivelMinimo: 0.5 };
const nivelDe = (v: string | undefined) => Number(/([1-5])/.exec(v ?? '')?.[1] ?? 0);
const plano = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').trim();

export const laboratorioClasificador: Laboratorio<ContextoClasificador> = {
  escenarios: [{
    id: 'frente-a-la-persona', tipo: 'replay', descripcion: 'Nivel y dominio del clasificador frente a los que anotó la persona en la hoja',
    ejecutar: async (ctx) => {
      const anotadas = (await ctx.tareas()).filter((t) => t.clasificacionHumana['nivel_tarea']?.length || t.clasificacionHumana['dominio']?.length);
      let nN = 0, exacto = 0, cerca = 0, nD = 0, dominio = 0;
      for (const t of anotadas) {
        const c = ctx.clasificar(t.prompt);
        const humano = nivelDe(t.clasificacionHumana['nivel_tarea']?.[0]);
        if (humano) {
          const k = nivelDe(c.complexity_level);
          nN++; if (k === humano) exacto++; if (Math.abs(k - humano) <= 1) cerca++;
        }
        const doms = (t.clasificacionHumana['dominio'] ?? []).map(plano);
        if (doms.length) { nD++; if (c.domain.some((d) => doms.includes(plano(d)))) dominio++; }
      }
      const U = UMBRALES_CLASIFICADOR;
      const hallazgos: Hallazgo[] = nN >= U.muestraMinima && wilson(exacto, nN)[1] < U.nivelMinimo ? [{
        clave: 'nivel-frente-a-persona', severidad: 'media', titulo: 'El clasificador no coincide con la persona en el nivel de las tareas',
        evidencia: `Nivel exacto en ${exacto}/${nN} tareas anotadas (IC95 superior ${wilson(exacto, nN)[1].toFixed(2)} < ${U.nivelMinimo}); a ±1 nivel, ${cerca}/${nN}.`,
        propuesta: 'Recalibrar los pesos y umbrales de complejidad (`CONFIG_POR_DEFECTO` en `heuristica.ts`) con las tareas anotadas, o abordar la clasificación con LLM pendiente en PORTE.md.',
      }] : [];
      return {
        muestra: anotadas.length, suficiente: nN >= U.muestraMinima, hallazgos,
        metricas: { nivel_exacto: proporcion(exacto, nN), nivel_mas_menos_1: proporcion(cerca, nN), dominio: proporcion(dominio, nD), anotadas_nivel: nN, anotadas_dominio: nD },
        umbrales: { muestra: `≥ ${U.muestraMinima} tareas con nivel anotado`, nivel_exacto: `IC95 superior ≥ ${U.nivelMinimo}` },
      };
    },
  }],
};
