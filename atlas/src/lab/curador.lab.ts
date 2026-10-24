import { curar, REGLAS_CURADOR, UMBRALES_CURADOR, type EntradaCurador } from '../curador';
import type { Hallazgo } from '../pasarela-borradores';
import { proporcion, wilson, type ContextoLab, type Laboratorio, type Resultado } from '../laboratorio';

/**
 * Laboratorio del curador. El contrato comprueba lo que el curador promete (determinista, nunca propone una protegida, cada
 * propuesta cita su regla y su evidencia, ninguna se apoya en estrellas heredadas). El feedback mide su precisión frente a lo que la
 * persona hizo con sus borradores en la pasarela: aceptados contra descartados, con intervalo de Wilson y muestra mínima.
 */
export interface ContextoCurador extends ContextoLab {
  /** Las skills del equipo con sus fichas, usos, recomendaciones y protegidas, tal como están ahora (solo lectura). */
  entrada(): EntradaCurador;
  /** Los borradores `curador:*` de la pasarela con su estado actual en Atlas dev. */
  borradores(): Promise<{ clave: string; estado: string }[]>;
}

export const UMBRALES_LAB_CURADOR = { muestraMinima: 20, muestraMinimaRegla: 10, precisionMinima: 0.5 };

export const laboratorioCurador: Laboratorio<ContextoCurador> = {
  escenarios: [
    {
      id: 'invariantes', tipo: 'contrato', descripcion: 'Determinista, sin protegidas, con regla y evidencia en cada propuesta y sin apoyarse en estrellas heredadas',
      ejecutar: (ctx): Resultado => {
        const e = ctx.entrada();
        const p = curar(e);
        const reglas = new Set<string>(REGLAS_CURADOR.map((r) => r.id));
        const clave = (x: typeof p) => JSON.stringify(x);
        const determinista = clave(p) === clave(curar(e)) && clave(p) === clave(curar({ ...e, skills: [...e.skills].reverse(), protegidas: [...e.protegidas].reverse() }));
        const protegidas = new Set(e.protegidas);
        const deProtegidas = p.filter((x) => protegidas.has(x.skill));
        const sinCita = p.filter((x) => !reglas.has(x.regla) || !x.evidencia.trim());
        const heredadas = p.filter((x) => x.regla === 'superada-por-grupo' && (!e.fichas[x.skill] || e.fichas[x.skill]!.heredadas || e.fichas[x.skill]!.estrellas === null));
        const hallazgos: Hallazgo[] = [];
        const roto = (clave: string, titulo: string, evidencia: string) => hallazgos.push({ clave, severidad: 'alta', titulo, evidencia, propuesta: 'Corregir `atlas/src/curador.ts`: el curador incumple su contrato.' });
        if (!determinista) roto('curador-no-determinista', 'El curador no es determinista', 'Dos ejecuciones con la misma entrada (o con las skills en otro orden) dieron propuestas distintas.');
        if (deProtegidas.length) roto('curador-propone-protegidas', 'El curador propone skills protegidas', `Protegidas propuestas: ${deProtegidas.map((x) => x.skill).join(', ')}.`);
        if (sinCita.length) roto('curador-sin-evidencia', 'Hay propuestas sin regla o sin evidencia', `Propuestas sin cita: ${sinCita.map((x) => `${x.skill}/${x.regla}`).join(', ')}.`);
        if (heredadas.length) roto('curador-estrellas-heredadas', 'El curador se apoya en estrellas heredadas', `Propuestas por estrellas sin estrellas propias: ${heredadas.map((x) => x.skill).join(', ')}.`);
        return {
          muestra: e.skills.length, suficiente: e.skills.length > 0, hallazgos,
          metricas: { propuestas: p.length, determinista: determinista ? 1 : 0, protegidas_propuestas: deProtegidas.length, sin_evidencia: sinCita.length, basadas_en_heredadas: heredadas.length },
          umbrales: { determinista: '= 1', protegidas_propuestas: '= 0', sin_evidencia: '= 0', basadas_en_heredadas: '= 0' },
          detalle: { por_regla: Object.fromEntries(REGLAS_CURADOR.map((r) => [r.id, p.filter((x) => x.regla === r.id).length])), reglas: Object.fromEntries(REGLAS_CURADOR.map((r) => [r.id, r.umbral({ ...UMBRALES_CURADOR, ...e.umbrales })])) },
        };
      },
    },
    {
      id: 'precision', tipo: 'feedback', descripcion: 'Precisión del curador: borradores aceptados frente a descartados por la persona',
      ejecutar: async (ctx): Promise<Resultado> => {
        const U = UMBRALES_LAB_CURADOR;
        const previos = (await ctx.borradores()).filter((b) => b.clave.startsWith('curador:'));
        const regla = (clave: string) => clave.split(':')[1] ?? '?';
        const acept = previos.filter((b) => b.estado !== 'borrador' && b.estado !== 'descartada');
        const desc = previos.filter((b) => b.estado === 'descartada');
        const n = acept.length + desc.length;
        const [inf, sup] = wilson(acept.length, n);
        const suficiente = n >= U.muestraMinima;
        const hallazgos: Hallazgo[] = [];
        const porRegla: Record<string, { aceptadas: number; descartadas: number; ic: [number, number] }> = {};
        for (const r of REGLAS_CURADOR) {
          const a = acept.filter((b) => regla(b.clave) === r.id).length, d = desc.filter((b) => regla(b.clave) === r.id).length;
          if (a + d) porRegla[r.id] = { aceptadas: a, descartadas: d, ic: wilson(a, a + d).map((x) => Math.round(x * 1000) / 1000) as [number, number] };
          if (suficiente && a + d >= U.muestraMinimaRegla && wilson(a, a + d)[1] < U.precisionMinima) {
            hallazgos.push({ clave: `precision-${r.id}`, severidad: 'media', titulo: `La persona descarta la mayoría de los borradores de la regla ${r.id}`, evidencia: `${a} aceptados y ${d} descartados; IC95 de la precisión [${wilson(a, a + d).map((x) => x.toFixed(2)).join(', ')}], su techo está por debajo de ${U.precisionMinima}.`, propuesta: `Endurecer el umbral de la regla ${r.id} en \`atlas/src/curador.ts\` (hoy: ${r.umbral(UMBRALES_CURADOR)}) o retirarla.` });
          }
        }
        return {
          muestra: n, suficiente, hallazgos,
          metricas: { aceptadas: acept.length, descartadas: desc.length, pendientes: previos.length - n, precision: proporcion(acept.length, n), precision_ic_inf: n ? Math.round(inf * 1000) / 1000 : null, precision_ic_sup: n ? Math.round(sup * 1000) / 1000 : null },
          umbrales: { muestra: `≥ ${U.muestraMinima} borradores resueltos`, techo_ic_por_regla: `≥ ${U.precisionMinima} (con ≥ ${U.muestraMinimaRegla} por regla)` }, detalle: { por_regla: porRegla },
        };
      },
    },
  ],
};
