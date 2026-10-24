import type { Hallazgo } from './pasarela-borradores';
import type { Modo } from './modo';
import { proporcion, wilson, type ContextoLab, type Laboratorio, type Resultado, type TareaAnonima } from './laboratorio';

/**
 * Laboratorio A/B de los modificadores (eficiencia, método, prompts), común a los tres: cada uno aporta su transformador y las
 * skills que lo representan en la hoja de una tarea. Es OBSERVACIONAL, no aleatorizado: la persona decidió qué skills llevaba
 * cada tarea, así que la comparación no prueba causalidad. Por eso solo concluye con ambos brazos por encima de la muestra
 * mínima y con intervalos de Wilson que no se solapan, y lo que concluye sale como borrador, nunca aplicado.
 */
export interface TareaCtx { nivel: number; intencion: string }
export interface Transformador {
  /** Marca que deja en la instrucción (para ser idempotente). */
  marca: string;
  /** Máximo de caracteres que puede añadir a una instrucción. */
  maxSobrecoste: number;
  aplica(modo: Modo, c: TareaCtx): boolean;
  aplicar(instruccion: string, modo: Modo, c: TareaCtx): string;
}
export interface DefModificador { id: string; nombre: string; skills: string[]; transformador: Transformador }
export interface ContextoModificador extends ContextoLab { clasificar(prompt: string): { nivel: number; dominio: string; intencion: string } }

export const UMBRALES_AB = { muestraMinima: 20, calibracionMinima: 20 };

export interface Brazo { n: number; aciertos: number; retrabajos: number; acierto: [number, number]; retrabajo: [number, number] }
const brazo = (ts: TareaAnonima[]): Brazo => {
  const aciertos = ts.filter((t) => t.exito === true).length, retrabajos = ts.filter((t) => t.retrabajo).length;
  return { n: ts.length, aciertos, retrabajos, acierto: wilson(aciertos, ts.length), retrabajo: wilson(retrabajos, ts.length) };
};
const separados = (x: [number, number], y: [number, number]): 'x' | 'y' | null => (x[0] > y[1] ? 'x' : y[0] > x[1] ? 'y' : null);

/** Compara dos brazos; solo hay conclusión con ambos ≥ muestra mínima y los IC95 de Wilson sin solaparse. */
export function compararBrazos(a: TareaAnonima[], b: TareaAnonima[], minima = UMBRALES_AB.muestraMinima) {
  const A = brazo(a), B = brazo(b);
  const suficiente = A.n >= minima && B.n >= minima;
  // Acierto: más es mejor. Re-trabajo: menos es mejor.
  const sAcierto = suficiente ? separados(A.acierto, B.acierto) : null, sRetrabajo = suficiente ? separados(B.retrabajo, A.retrabajo) : null;
  const mejorA = (sAcierto === 'x' ? 1 : 0) + (sRetrabajo === 'x' ? 1 : 0), peorA = (sAcierto === 'y' ? 1 : 0) + (sRetrabajo === 'y' ? 1 : 0);
  const conclusion: 'a-mejor' | 'a-peor' | 'mixta' | 'sin-diferencia' | 'sin-muestra' = !suficiente ? 'sin-muestra'
    : mejorA && peorA ? 'mixta' : mejorA ? 'a-mejor' : peorA ? 'a-peor' : 'sin-diferencia';
  return { A, B, suficiente, conclusion };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Elige el brazo B más comparable que llegue a la muestra mínima: mismo dominio×nivel, luego hoja escrita a mano, luego el resto. */
function elegirB(a: TareaAnonima[], resto: TareaAnonima[], seg: (t: TareaAnonima) => string, minima: number): { b: TareaAnonima[]; comparacion: 'segmento' | 'hoja' | 'resto' } {
  const segs = new Set(a.map(seg));
  const hoja = resto.filter((t) => t.agenteHumano);
  for (const [comparacion, b] of [['segmento', hoja.filter((t) => segs.has(seg(t)))], ['hoja', hoja], ['resto', resto]] as const) {
    if (b.length >= minima) return { b: [...b], comparacion };
  }
  return { b: resto, comparacion: 'resto' };
}

/** Los tres escenarios de un modificador: contrato del transformador, replay A/B observacional y feedback de las calibraciones. */
export function laboratorioModificador(def: DefModificador): Laboratorio<ContextoModificador> {
  const t = def.transformador;
  const U = UMBRALES_AB;
  return {
    escenarios: [
      {
        id: 'contrato', tipo: 'contrato', descripcion: `El transformador de ${def.nombre} es idempotente, conserva el texto, acota su sobrecoste y no hace nada en producción`,
        ejecutar: async (ctx): Promise<Resultado> => {
          const reales = (await ctx.tareas()).slice(0, 50).map((x) => x.prompt);
          const sinteticos = ['Corrige el error al guardar el perfil', 'Implementa el endpoint de exportación con tests', 'Revisa la arquitectura del módulo de pagos y propón un plan', 'Resume este texto'];
          const fallos = { texto_perdido: 0, no_idempotente: 0, sobrecoste: 0, mutacion_en_produccion: 0, aplica_en_produccion: 0, cambia_sin_aplicar: 0 };
          let casos = 0, aplicados = 0, maxExtra = 0;
          for (const p of [...sinteticos, ...reales]) {
            const k = ctx.clasificar(p);
            const c: TareaCtx = { nivel: k.nivel, intencion: k.intencion };
            casos++;
            const dev = t.aplicar(p, 'desarrollo', c);
            if (t.aplica('produccion', c)) fallos.aplica_en_produccion++;
            if (t.aplicar(p, 'produccion', c) !== p) fallos.mutacion_en_produccion++;
            if (t.aplica('desarrollo', c)) {
              aplicados++;
              if (!dev.includes(p)) fallos.texto_perdido++;
              if (t.aplicar(dev, 'desarrollo', c) !== dev) fallos.no_idempotente++;
              maxExtra = Math.max(maxExtra, dev.length - p.length);
              if (dev.length - p.length > t.maxSobrecoste) fallos.sobrecoste++;
            } else if (dev !== p) fallos.cambia_sin_aplicar++;
          }
          const rotos = Object.entries(fallos).filter(([, n]) => n > 0);
          const hallazgos: Hallazgo[] = rotos.length ? [{
            clave: `contrato-${def.id}`, severidad: 'alta', titulo: `El modificador ${def.nombre} rompe su contrato`,
            evidencia: `En ${casos} instrucciones: ${rotos.map(([k, n]) => `${k}=${n}`).join(', ')}.`,
            propuesta: `Revisar \`atlas/src/${def.id}.ts\`: debe ser idempotente, conservar el texto original, añadir como mucho ${t.maxSobrecoste} caracteres y devolver la instrucción intacta fuera de desarrollo.`,
          }] : [];
          return { muestra: casos, suficiente: casos > 0, hallazgos, metricas: { casos, aplicados, sobrecoste_max: maxExtra, ...fallos }, umbrales: { fallos: '= 0', sobrecoste: `≤ ${t.maxSobrecoste} caracteres` } };
        },
      },
      {
        id: 'replay-ab', tipo: 'replay', descripcion: `A/B observacional: tareas cuya hoja llevaba ${def.skills.join('/')} frente al resto comparable (no aleatorizado)`,
        ejecutar: async (ctx): Promise<Resultado> => {
          const terminadas = (await ctx.tareas()).filter((x) => x.exito !== null);
          const marca = (x: TareaAnonima) => x.skillsHoja.some((s) => def.skills.includes(s));
          const a = terminadas.filter(marca), resto = terminadas.filter((x) => !marca(x));
          const seg = (x: TareaAnonima) => { const k = ctx.clasificar(x.prompt); return `${k.dominio}×N${k.nivel}`; };
          const { b, comparacion } = elegirB(a, resto, seg, U.muestraMinima);
          const r = compararBrazos(a, b);
          const hallazgos: Hallazgo[] = [];
          const aviso = 'Es un estudio observacional, no aleatorizado: la persona eligió qué skills llevaba cada tarea, así que puede haber sesgo de selección (tareas más difíciles o más fáciles) y no prueba causalidad.';
          const ev = `${def.skills.join('/')} (A): acierto ${r.A.aciertos}/${r.A.n} [IC95 ${r3(r.A.acierto[0])}–${r3(r.A.acierto[1])}], re-trabajo ${r.A.retrabajos}/${r.A.n}. Resto comparable (B, ${comparacion}): acierto ${r.B.aciertos}/${r.B.n} [${r3(r.B.acierto[0])}–${r3(r.B.acierto[1])}], re-trabajo ${r.B.retrabajos}/${r.B.n}. ${aviso}`;
          if (r.conclusion === 'a-mejor') hallazgos.push({
            clave: `activar-${def.id}`, severidad: 'media', titulo: `El modificador ${def.nombre} parece mejorar el resultado: proponer activarlo en desarrollo`, evidencia: ev,
            propuesta: `Conectar \`atlas/src/${def.id}.ts\` al delegador solo en modo desarrollo, para las tareas donde aplica, y repetir \`kj lab run ${def.id}\` para confirmar. No se activa en producción sin una tarea aceptada.`,
            criterios: ['El delegador sigue sin cambiar en producción (paridad y perfiles en verde).', `El A/B de ${def.id} se repite con más tareas antes de darlo por bueno.`],
          });
          if (r.conclusion === 'a-peor') hallazgos.push({
            clave: `retirar-${def.id}`, severidad: 'media', titulo: `El modificador ${def.nombre} parece empeorar el resultado: proponer retirarlo`, evidencia: ev,
            propuesta: `Dejar de poner ${def.skills.join('/')} en las hojas por defecto y no conectar \`${def.id}\` al delegador; revisar si el efecto es de selección de tareas.`,
          });
          return {
            muestra: r.A.n + r.B.n, suficiente: r.suficiente, hallazgos,
            metricas: {
              n_a: r.A.n, n_b: r.B.n, acierto_a: proporcion(r.A.aciertos, r.A.n), acierto_b: proporcion(r.B.aciertos, r.B.n),
              acierto_a_inf: r.A.n ? r3(r.A.acierto[0]) : null, acierto_a_sup: r.A.n ? r3(r.A.acierto[1]) : null, acierto_b_inf: r.B.n ? r3(r.B.acierto[0]) : null, acierto_b_sup: r.B.n ? r3(r.B.acierto[1]) : null,
              dif_acierto: r.A.n && r.B.n ? r3(r.A.aciertos / r.A.n - r.B.aciertos / r.B.n) : null,
              retrabajo_a: proporcion(r.A.retrabajos, r.A.n), retrabajo_b: proporcion(r.B.retrabajos, r.B.n),
              dif_retrabajo: r.A.n && r.B.n ? r3(r.A.retrabajos / r.A.n - r.B.retrabajos / r.B.n) : null,
            },
            umbrales: { muestra: `≥ ${U.muestraMinima} tareas terminadas por brazo`, conclusion: 'IC95 de Wilson sin solaparse' },
            detalle: { diseno: 'observacional, no aleatorizado (la persona eligió las skills de cada hoja)', conclusion: r.conclusion, comparable: comparacion, skills_brazo_a: def.skills },
          };
        },
      },
      {
        id: 'feedback', tipo: 'feedback', descripcion: `Si la persona da por buena la aplicación de ${def.nombre} cuando se le propone (calibración)`,
        ejecutar: (ctx): Resultado => {
          const cal = ctx.calibraciones(def.id).filter((c) => c.respuesta !== 'sin_revisar');
          const si = cal.filter((c) => c.respuesta === 'si').length;
          const [lo, hi] = wilson(si, cal.length);
          const suficiente = cal.length >= U.calibracionMinima;
          const hallazgos: Hallazgo[] = suficiente && hi < 0.5 ? [{
            clave: `rechazado-${def.id}`, severidad: 'media', titulo: `La persona rechaza el modificador ${def.nombre} en la mayoría de los casos`,
            evidencia: `${si} de ${cal.length} propuestas aceptadas (IC95 ${r3(lo)}–${r3(hi)}, todo por debajo de 0,5).`,
            propuesta: `Retirar \`${def.id}\` de la lista de candidatos a activar o acotar mejor cuándo aplica (nivel e intención).`,
          }] : [];
          return {
            muestra: cal.length, suficiente, hallazgos,
            metricas: { aceptadas: cal.length ? proporcion(si, cal.length) : null, aceptadas_inf: cal.length ? r3(lo) : null, aceptadas_sup: cal.length ? r3(hi) : null },
            umbrales: { muestra: `≥ ${U.calibracionMinima} calibraciones`, rechazo: 'IC95 superior < 0,5' },
          };
        },
      },
    ],
  };
}
