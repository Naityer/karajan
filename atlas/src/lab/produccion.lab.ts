import type { Hallazgo } from '../pasarela-borradores';
import { proporcion, wilson, type ContextoLab, type Laboratorio, type Resultado, type TareaAnonima } from '../laboratorio';

/**
 * Laboratorio de producción: ¿el acierto y el re-trabajo que calcula `produccion.ts` dicen lo que dice la persona? Replay sobre las
 * tareas de Atlas dev anonimizadas, donde el re-trabajo se detecta con `motivoRetrabajo` (la misma regla de `produccion.ts`) y el
 * acierto es «terminada sin re-trabajo». La verdad humana es el estado final que dejó la persona (completada o fallida) y, la más
 * fiable, el de las tareas que además REVISÓ (hoja revisada). El caso que importa es el falso re-trabajo: una tarea completada que
 * `produccion.ts` cuenta como no acertada porque otra posterior se le parece. Con Wilson y muestra mínima.
 */
export const UMBRALES_PRODUCCION = { muestraMinima: 30, revisadasMinimas: 15, concordanciaMinima: 0.7 };

const resumen = (k: number, n: number) => {
  const [lo, hi] = wilson(k, n);
  return { concordancia: proporcion(k, n), ic_inf: n ? Math.round(lo * 1000) / 1000 : null, ic_sup: n ? Math.round(hi * 1000) / 1000 : null };
};

/** Acierto según `produccion.ts` frente al estado final de la persona; solo tareas terminadas. */
function concordancia(tareas: TareaAnonima[]): Resultado {
  const U = UMBRALES_PRODUCCION;
  const terminadas = tareas.filter((t) => t.exito !== null);
  const revisadas = terminadas.filter((t) => t.revisada);
  const humano = (t: TareaAnonima) => t.estado === 'completada';
  const iguales = terminadas.filter((t) => t.exito === humano(t));
  const igualesRev = revisadas.filter((t) => t.exito === humano(t));
  // Falsos re-trabajos: la persona la dio por buena y produccion.ts no.
  const falsos = terminadas.filter((t) => humano(t) && t.retrabajo);
  const falsosRev = revisadas.filter((t) => humano(t) && t.retrabajo);
  const suficiente = terminadas.length >= U.muestraMinima;
  const revSuficiente = revisadas.length >= U.revisadasMinimas;
  const hallazgos: Hallazgo[] = [];
  if (suficiente && wilson(iguales.length, terminadas.length)[1] < U.concordanciaMinima) hallazgos.push({
    clave: 'acierto-discrepa', severidad: 'media', titulo: 'El acierto de producción no coincide con el estado final que deja la persona',
    evidencia: `Coinciden ${iguales.length} de ${terminadas.length} tareas terminadas (IC95 superior ${wilson(iguales.length, terminadas.length)[1].toFixed(2)} < ${U.concordanciaMinima}); ${falsos.length} completadas se cuentan como no acertadas por re-trabajo.`,
    propuesta: 'Revisar los criterios de `motivoRetrabajo` en `atlas/src/produccion.ts` (ventana de 24 h, tejas de 8 palabras, ficheros comunes, verbos de corrección) con las tareas que la persona dio por buenas.',
  });
  if (revSuficiente && wilson(igualesRev.length, revisadas.length)[1] < U.concordanciaMinima) hallazgos.push({
    clave: 'acierto-discrepa-revisadas', severidad: 'media', titulo: 'Producción da por no acertadas tareas que la persona revisó y aceptó',
    evidencia: `En las ${revisadas.length} terminadas con hoja revisada coinciden ${igualesRev.length} (IC95 superior ${wilson(igualesRev.length, revisadas.length)[1].toFixed(2)} < ${U.concordanciaMinima}); ${falsosRev.length} completadas figuran con re-trabajo.`,
    propuesta: 'Afinar `motivoRetrabajo` para que una tarea de seguimiento no marque como repetida la anterior cuando la persona la aceptó.',
  });
  return {
    muestra: terminadas.length, suficiente, hallazgos: suficiente || revSuficiente ? hallazgos : [],
    metricas: {
      terminadas: terminadas.length, revisadas: revisadas.length, concordancia: proporcion(iguales.length, terminadas.length), concordancia_revisadas: proporcion(igualesRev.length, revisadas.length),
      falsos_retrabajo: falsos.length, falsos_retrabajo_revisadas: falsosRev.length, retrabajo: proporcion(tareas.filter((t) => t.retrabajo).length, tareas.length),
    },
    umbrales: { muestra: `≥ ${U.muestraMinima} terminadas (${U.revisadasMinimas} revisadas para el subconjunto)`, concordancia: `IC95 superior ≥ ${U.concordanciaMinima}` },
    detalle: { todas: resumen(iguales.length, terminadas.length), revisadas: resumen(igualesRev.length, revisadas.length), por_estado: { completada: terminadas.filter(humano).length, fallida: terminadas.filter((t) => !humano(t)).length } },
  };
}

export const laboratorioProduccion: Laboratorio<ContextoLab> = {
  escenarios: [
    { id: 'concordancia', tipo: 'replay', descripcion: 'El acierto y el re-trabajo de produccion.ts frente al estado final y la revisión de la persona en Atlas dev', ejecutar: async (c) => concordancia(await c.tareas()) },
  ],
};
