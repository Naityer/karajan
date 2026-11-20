import { planificar, sugerirSubagente, type ContextoPlanificador, type EntradaPlanificar, type PlanEjecucion, type TareaClasificada } from '../planificador';
import { validarCombinacion, MODOS_BASE } from '../planificador-modos';
import type { ConfigPlanificador } from '../planificador-registro';
import type { Hallazgo } from '../pasarela-borradores';
import type { ContextoLab, Laboratorio, Resultado } from '../laboratorio';

/**
 * Laboratorio del planificador. Dos preguntas:
 *   ¿construye planes correctos?  (`contrato`: cada modo y cada combinación válida da un plan coherente —actores que existen, dependencias sin
 *                                  ciclos, hitos con objetivo/entregable/validación, checker al final, jefe de 5 min— y las combinaciones
 *                                  incompatibles se rechazan explicando por qué)
 *   ¿elige bien en auto?          (`replay`: tareas sintéticas de nivel 1 a 5, con y sin presión de cuota: lo barato para lo simple, nunca
 *                                  más caro bajo presión, y siempre con la comparación y los datos que la fundamentan)
 * Todo es sintético y en memoria: no ejecuta ningún agente ni lee ni escribe registros reales.
 */
export interface ContextoPlanificadorLab extends ContextoLab {
  /** La configuración viva (normalizada). */
  config(): ConfigPlanificador;
}

const tarea = (nivel: number, dominio: string[] = ['programming'], n = 4): TareaClasificada => ({ nivel, dominio, subtareas: Array.from({ length: n }, (_, i) => ({ nombre: i === n - 1 && n > 2 ? 'Añadir pruebas' : `Parte ${i + 1}`, validacion: `La parte ${i + 1} funciona`, complejidad: i + 1 })) });
const contexto = (config: ConfigPlanificador, extra: Partial<ContextoPlanificador> = {}): ContextoPlanificador => ({ config, ahora: () => new Date('2026-11-04T12:00:00Z'), ...extra });

interface Caso { nombre: string; ok: boolean; detalle: string }
/** Dependencias que existen y sin ciclos, y actores que existen. */
function coherente(p: PlanEjecucion): string | null {
  const ids = new Set(p.pasos.map((x) => x.id));
  if (!p.pasos.length) return 'sin pasos';
  for (const x of p.pasos) {
    if (!p.actores[x.actor]) return `el paso ${x.id} usa un actor inexistente (${x.actor})`;
    for (const d of x.depende) if (!ids.has(d)) return `el paso ${x.id} depende de ${d}, que no existe`;
    if (!x.entregable || !x.validacion) return `el paso ${x.id} no tiene entregable o criterio de validación`;
  }
  const estado = new Map<string, 1 | 2>(), por = new Map(p.pasos.map((x) => [x.id, x]));
  let ciclo = false;
  const visita = (id: string) => { if (estado.get(id) === 2) return; if (estado.get(id) === 1) { ciclo = true; return; } estado.set(id, 1); for (const d of por.get(id)!.depende) visita(d); estado.set(id, 2); };
  for (const x of p.pasos) visita(x.id);
  return ciclo ? 'hay un ciclo de dependencias' : null;
}

export function casosContrato(config: ConfigPlanificador): Caso[] {
  const ctx = contexto(config), lista: Caso[] = [];
  const caso = (nombre: string, ok: boolean, detalle: string) => lista.push({ nombre, ok, detalle });
  const plan = (e: Partial<EntradaPlanificar> & Pick<EntradaPlanificar, 'solicitud'>, t = tarea(3)) => planificar({ tarea: t, agente: 'claude', ...e }, ctx);

  for (const m of MODOS_BASE) {
    const p = plan({ solicitud: { modo: m } }, tarea(4, ['programming', 'security']));
    const c = p.errores.length ? p.errores.join(' · ') : coherente(p);
    caso(`${m}: plan coherente`, !c, c ?? '');
  }
  const classic = plan({ solicitud: { modo: 'classic' } });
  caso('classic: un solo agente y un solo paso de trabajo', Object.keys(classic.actores).length === 1 && classic.pasos.filter((x) => x.tipo === 'trabajo').length === 1, `actores ${Object.keys(classic.actores).join(',')}`);
  const ms = plan({ solicitud: { modo: 'master-slave' } }, tarea(4));
  caso('master-slave: principal de nivel superior y subagentes de su familia', ms.actores['principal']?.nivel === 'superior' && Object.values(ms.actores).filter((a) => a.id.startsWith('sub')).every((a) => a.agente === 'claude'), JSON.stringify(Object.values(ms.actores).map((a) => `${a.id}:${a.agente}/${a.nivel}`)));
  const sug = sugerirSubagente('codex', contexto({ ...config, agentes: { ...config.agentes, codex: { ...config.agentes['codex']!, activo: false } } }));
  caso('sugerir subagente: sin la familia activa avisa y usa otro', sug.agente !== 'codex' && !!sug.aviso, JSON.stringify(sug));
  const sin = plan({ solicitud: { modo: 'master-slave' } }, tarea(3, ['programming'], 1));
  caso('master-slave: con una sola tarea hay un esclavo y el principal integra', sin.pasos.some((x) => x.tipo === 'integracion' && x.actor === 'principal') && coherente(sin) === null, coherente(sin) ?? '');
  const single = plan({ solicitud: { modo: 'single-agent' } });
  caso('single-agent: como mucho un subagente, de nivel bajo', Object.values(single.actores).filter((a) => a.id.startsWith('sub')).length <= 1 && Object.values(single.actores).filter((a) => a.id.startsWith('sub')).every((a) => a.nivel === 'bajo' && a.esfuerzo === 'bajo'), JSON.stringify(Object.keys(single.actores)));
  const co = plan({ solicitud: { modo: 'co-work' } }, tarea(4));
  const esp = Object.values(co.actores).filter((a) => a.id !== 'jefe' && a.id !== 'checker');
  caso('co-work: al menos dos especialistas con ámbito, repo común y jefe de 5 minutos', esp.length >= 2 && esp.every((a) => !!a.ambito) && co.repoComun && co.jefe?.intervencionMin === 5 && co.pasos.some((x) => x.tipo === 'jefe' && x.bajoDemanda), `especialistas ${esp.length}, jefe ${co.jefe?.intervencionMin}`);
  const hitos = plan({ solicitud: { modo: 'master-slave', modificadores: ['milestone', 'checker'] } }, tarea(4));
  const sint = hitos.pasos.filter((x) => x.tipo === 'sintesis').length;
  caso('milestone: hitos con objetivo, entregable y validación, y síntesis entre hitos', hitos.hitos.length >= 2 && hitos.hitos.every((h) => h.objetivo && h.entregable && h.validacion) && sint === hitos.hitos.length - 1, `${hitos.hitos.length} hitos, ${sint} síntesis`);
  caso('milestone: cada hito empieza cuando acaba el anterior', hitos.hitos.slice(1).every((h, i) => { const primero = hitos.pasos.find((x) => x.id === h.pasos[0]); const previo = hitos.pasos.find((x) => x.id === hitos.hitos[i]!.pasos.at(-1)); return !!primero && !!previo && primero.depende.includes(previo.id); }), '');
  const ultimo = hitos.pasos.at(-1);
  caso('checker: último paso, actor ligero y criterios de revisión', ultimo?.tipo === 'checker' && hitos.actores['checker']?.nivel === 'bajo' && hitos.checker?.criterios.length === 3, `${ultimo?.tipo}`);
  const lazy = plan({ solicitud: { modo: 'classic', modificadores: ['lazy-agent', 'milestone'] } });
  caso('lazy-agent + milestone: agente de nivel bajo y plan troceado', lazy.actores['principal']?.nivel === 'bajo' && lazy.hitos.length >= 2, `nivel ${lazy.actores['principal']?.nivel}, ${lazy.hitos.length} hitos`);
  caso('modificador dado como modo: se acepta y se explica', validarCombinacion({ modo: 'lazy-agent' }).ok && validarCombinacion({ modo: 'lazy-agent' }).modificadores[0] === 'lazy-agent', '');
  const malas: [string, Parameters<typeof validarCombinacion>[0]][] = [
    ['classic con subagentes', { modo: 'classic', subagentes: [{ agente: 'codex' }] }], ['single-agent con 2 subagentes', { modo: 'single-agent', subagentes: [{}, {}] }],
    ['co-work con lazy-agent', { modo: 'co-work', modificadores: ['lazy-agent'] }], ['modo desconocido', { modo: 'turbo' }], ['modificador desconocido', { modificadores: ['x'] }],
  ];
  for (const [n, s] of malas) { const v = validarCombinacion(s); caso(`rechaza: ${n}`, !v.ok && v.errores.every((x) => x.length > 20), v.errores.join(' · ')); }
  const rechazado = plan({ solicitud: { modo: 'co-work', modificadores: ['lazy-agent'] } });
  caso('un plan rechazado no tiene pasos y lo dice en el motivo', rechazado.pasos.length === 0 && rechazado.errores.length > 0 && /rechazado/i.test(rechazado.motivo), rechazado.motivo);
  const au = plan({ solicitud: { modo: 'auto' } }, tarea(3));
  caso('auto: crea un plan, compara formatos y explica la decisión', au.modo !== 'auto' && au.alternativas.length >= 3 && /Auto eligió/.test(au.motivo) && coherente(au) === null, au.motivo);
  return lista;
}

function contrato(ctx: ContextoPlanificadorLab): Resultado {
  const hallazgos: Hallazgo[] = [], casos = casosContrato(ctx.config()), fallos = casos.filter((c) => !c.ok);
  if (fallos.length) hallazgos.push({
    clave: 'plan-incoherente', severidad: 'alta', titulo: `${fallos.length} de ${casos.length} comprobaciones del planificador no se cumplen`,
    evidencia: fallos.map((f) => `${f.nombre}: ${f.detalle}`).join('\n'),
    propuesta: 'Corregir `atlas/src/planificador.ts` o `planificador-modos.ts`: Atlas dev ejecuta lo que dice el plan, y un plan incoherente se ejecuta mal.',
  });
  return { muestra: casos.length, suficiente: true, metricas: { comprobaciones: casos.length, fallidas: fallos.length }, hallazgos, detalle: { fallos } };
}

function replay(ctx: ContextoPlanificadorLab): Resultado {
  const hallazgos: Hallazgo[] = [], config = ctx.config(), filas: { nivel: number; cuota: string; modo: string; coste: number }[] = [];
  const fallos: string[] = [];
  for (const nivel of [1, 2, 3, 4, 5]) {
    const normal = planificar({ solicitud: { modo: 'auto' }, tarea: tarea(nivel, ['programming', 'devops']), agente: 'claude' }, contexto(config, { cuota: () => ({ modo: 'normal' }) }));
    const presion = planificar({ solicitud: { modo: 'auto' }, tarea: tarea(nivel, ['programming', 'devops']), agente: 'claude' }, contexto(config, { cuota: () => ({ modo: 'frenado' }) }));
    filas.push({ nivel, cuota: 'normal', modo: normal.modo, coste: normal.metricas.estimacion?.coste ?? 0 }, { nivel, cuota: 'frenado', modo: presion.modo, coste: presion.metricas.estimacion?.coste ?? 0 });
    if (nivel === 1 && normal.modo === 'co-work') fallos.push('nivel 1: co-work para una tarea simple');
    if ((presion.metricas.estimacion?.coste ?? 0) > (normal.metricas.estimacion?.coste ?? 0) + 1e-9) fallos.push(`nivel ${nivel}: con la cuota frenada el plan cuesta más (${presion.metricas.estimacion?.coste} > ${normal.metricas.estimacion?.coste})`);
    if (!presion.modificadores.includes('lazy-agent')) fallos.push(`nivel ${nivel}: con la cuota frenada auto no pasa a lazy-agent`);
    if (!normal.alternativas.length || !normal.motivo) fallos.push(`nivel ${nivel}: auto no deja la comparación ni el motivo`);
  }
  if (fallos.length) hallazgos.push({ clave: 'auto-incoherente', severidad: 'media', titulo: `auto toma ${fallos.length} decisión(es) incoherente(s) en tareas sintéticas`, evidencia: fallos.join('\n'), propuesta: 'Revisar los pesos y los priors de `planificador.ts` (`pesos`, `pesoNivel`) frente a lo que miden coste y acierto reales.' });
  return { muestra: filas.length, suficiente: filas.length >= 10, metricas: { escenarios: filas.length, incoherentes: fallos.length }, hallazgos, detalle: { filas } };
}

export const laboratorioPlanificador: Laboratorio<ContextoPlanificadorLab> = {
  escenarios: [
    { id: 'contrato', tipo: 'contrato', descripcion: 'Cada modo y cada combinación válida da un plan coherente; las incompatibles se rechazan con motivo', ejecutar: contrato },
    { id: 'replay', tipo: 'replay', descripcion: 'Auto en tareas sintéticas de nivel 1 a 5, con y sin presión de cuota: elige lo barato para lo simple y justifica la decisión', ejecutar: replay },
  ],
};
