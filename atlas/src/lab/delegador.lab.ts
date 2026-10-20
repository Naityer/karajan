import type { Plan } from '../delegar';
import type { Hallazgo } from '../pasarela-borradores';
import { describirPerfil } from '../perfil-texto';
import { validarLayout } from '../perfiles';
import { casaRegla, detectarAreas, nivelRegla, type Perfil, type Regla } from '../reglas';
import { proporcion, wilson, type ContextoLab, type Laboratorio, type TareaAnonima } from '../laboratorio';

/**
 * Laboratorio del delegador. Separa dos preguntas que no son la misma:
 *   ¿hace bien su función?   (fidelidad: cada decisión sale de una regla o un nivel del perfil; determinismo)
 *   ¿el perfil sirve?        (a ciegas frente a la persona: concordancia y, por segmento dominio×nivel, si la persona acierta
 *                             donde el perfil la contradice → se propone un perfil nuevo con lo que las métricas piden)
 * El delegador solo PLANIFICA (sin ejecutar ni mirar qué CLI hay en este equipo): se mide el perfil, no la máquina.
 */
export interface ContextoDelegador extends ContextoLab {
  perfil(): Perfil;
  planificar(prompt: string): Plan;
}

const NIVELES = ['level_1_simple', 'level_2_moderate', 'level_3_intermediate', 'level_4_complex', 'level_5_critical'];
export const UMBRALES_DELEGADOR = { muestraMinima: 20, segmentoMinimo: 10, discrepanciaWilson: 0.3, exitoHumano: 0.7 };

/** El agente que el plan da a la tarea: el de más subtareas (a igualdad, el de la primera). */
export function agenteDelPlan(p: Plan): string | null {
  const cuenta = new Map<string, number>();
  for (const a of p.asignaciones) cuenta.set(a.proveedor, (cuenta.get(a.proveedor) ?? 0) + 1);
  let mejor: string | null = null;
  for (const a of p.asignaciones) if (mejor === null || (cuenta.get(a.proveedor) ?? 0) > (cuenta.get(mejor) ?? 0)) mejor = a.proveedor;
  return mejor;
}

const sinCondiciones = (r: Regla) => r.enabled !== false && !r.domains?.length && !r.intents?.length && (r.level_min ?? null) === null && (r.level_max ?? null) === null;
const nivelNum = (p: Plan) => Math.max(1, NIVELES.indexOf(p.clasificacion.complexity_level) + 1);
const segmento = (p: Plan) => `${p.clasificacion.domain[0] ?? 'general'}×N${nivelNum(p)}`;

function fidelidad(ctx: ContextoDelegador, tareas: TareaAnonima[]) {
  const perfil = ctx.perfil();
  const reglas = (perfil.rules ?? []).filter((r) => r.enabled !== false);
  const hallazgos: Hallazgo[] = [];
  let decisiones = 0, trazables = 0;
  const elegidas = new Map<string, number>(), casables = new Map<string, number>(), usadas = new Map<string, number>();
  const noTrazables: string[] = [];
  for (const t of tareas) {
    const plan = ctx.planificar(t.prompt);
    const c = plan.clasificacion;
    for (const [i, a] of plan.asignaciones.entries()) {
      decisiones++;
      const st = c.subtasks[i]!;
      const nivel = nivelRegla(c.complexity_level, st.complexity);
      const conjunto = new Set([...c.domain, ...detectarAreas(c.original_prompt)]);
      for (const r of reglas) if (casaRegla(r, conjunto, c.intent, nivel)) casables.set(r.id, (casables.get(r.id) ?? 0) + 1);
      if (a.entidad) usadas.set(a.entidad, (usadas.get(a.entidad) ?? 0) + 1);
      const regla = a.regla ? reglas.find((r) => r.id === a.regla) : null;
      const entidad = perfil.entities.find((e) => e.id === a.entidad);
      const ok = a.regla
        ? !!regla && regla.entity_id === a.entidad && casaRegla(regla, conjunto, c.intent, nivel)
        : !!entidad && ((entidad.levels ?? []).includes(NIVELES[nivel - 1]!) || /respaldo|límite|admite skills/.test(a.motivo));
      if (a.regla) elegidas.set(a.regla, (elegidas.get(a.regla) ?? 0) + 1);
      if (ok) trazables++; else if (noTrazables.length < 10) noTrazables.push(`${t.hash}/${st.id}: ${a.motivo}`);
    }
  }
  if (decisiones > trazables) hallazgos.push({
    clave: 'no-trazable', severidad: 'alta', titulo: 'El delegador toma decisiones que no salen de su perfil',
    evidencia: `${decisiones - trazables} de ${decisiones} asignaciones no corresponden a la regla o al nivel que dicen aplicar:\n${noTrazables.map((x) => `- ${x}`).join('\n')}`,
    propuesta: 'Revisar `asignar` en `atlas/src/delegar.ts` frente a `elegirRegla` y los niveles de las entidades del perfil por defecto.',
  });
  // Niveles que nadie atiende (y sin una regla que lo cubra todo): una tarea de ese nivel cae al primero que haya.
  const cubiertos = new Set(perfil.entities.flatMap((e) => e.levels ?? []));
  const huecos = NIVELES.filter((n) => !cubiertos.has(n));
  if (huecos.length && !reglas.some(sinCondiciones)) hallazgos.push({
    clave: 'niveles-sin-agente', severidad: 'alta', titulo: `El perfil «${perfil.name}» no tiene agente para ${huecos.map((n) => `N${NIVELES.indexOf(n) + 1}`).join(', ')}`,
    evidencia: `Ninguna entidad declara esos niveles y no hay regla sin condiciones: esas tareas van al primer agente del perfil por descarte.`,
    propuesta: 'Asignar esos niveles a un agente o añadir una regla final «todo lo demás».',
  });
  // Reglas que nunca pueden elegirse porque una anterior sin condiciones se lo lleva todo (estructural, no depende del corpus).
  const corte = reglas.findIndex(sinCondiciones);
  const tapadas = corte >= 0 ? reglas.slice(corte + 1) : [];
  if (tapadas.length) hallazgos.push({
    clave: 'reglas-tapadas', severidad: 'media', titulo: `Reglas que nunca se aplican: ${tapadas.map((r) => r.name || r.id).join(', ')}`,
    evidencia: `Van detrás de «${reglas[corte]!.name || reglas[corte]!.id}», que no tiene condiciones y casa con todo.`,
    propuesta: 'Moverlas delante de la regla general o quitarlas.',
  });
  const suficiente = tareas.length >= UMBRALES_DELEGADOR.muestraMinima;
  const nunca = reglas.filter((r) => !casables.get(r.id) && !tapadas.includes(r));
  if (nunca.length) hallazgos.push({
    clave: 'reglas-sin-uso', severidad: suficiente ? 'media' : 'baja', titulo: `Reglas que no casan con ninguna tarea real: ${nunca.map((r) => r.name || r.id).join(', ')}`,
    evidencia: `Sobre ${tareas.length} tareas reales de Atlas dev ninguna cumple sus condiciones (dominios, intención y niveles).`,
    propuesta: 'Ajustar sus condiciones al vocabulario de las tareas reales o quitarlas.',
  });
  const sinUso = perfil.entities.filter((e) => e.provider && !usadas.get(e.id));
  if (sinUso.length) hallazgos.push({
    clave: 'agentes-sin-uso', severidad: 'baja', titulo: `Agentes del perfil a los que nunca llega nada: ${sinUso.map((e) => e.name ?? e.id).join(', ')}`,
    evidencia: `Ninguna de las ${tareas.length} tareas reales se les asignaría.`, propuesta: 'Quitar el agente o darle niveles o reglas.',
  });
  return {
    muestra: tareas.length, suficiente, hallazgos,
    metricas: { decisiones, trazabilidad: proporcion(trazables, decisiones), reglas_activas: reglas.length, reglas_tapadas: tapadas.length, reglas_sin_uso: nunca.length, niveles_sin_agente: huecos.length },
    umbrales: { trazabilidad: '= 1', muestra: `≥ ${UMBRALES_DELEGADOR.muestraMinima} tareas para valorar reglas sin uso` },
    detalle: { perfil: perfil.name, reglas: reglas.map((r) => ({ regla: r.name || r.id, casa: casables.get(r.id) ?? 0, elegida: elegidas.get(r.id) ?? 0 })) },
  };
}

function concordancia(ctx: ContextoDelegador, tareas: TareaAnonima[]) {
  const humanas = tareas.filter((t) => t.agenteHumano);
  const matriz: Record<string, Record<string, number>> = {};
  const porSegmento: Record<string, { n: number; iguales: number }> = {};
  let iguales = 0;
  for (const t of humanas) {
    const p = ctx.planificar(t.prompt);
    const k = agenteDelPlan(p) ?? '-';
    (matriz[t.agenteHumano!] ??= {})[k] = (matriz[t.agenteHumano!]![k] ?? 0) + 1;
    const s = (porSegmento[segmento(p)] ??= { n: 0, iguales: 0 });
    s.n++;
    if (k === t.agenteHumano) { iguales++; s.iguales++; }
  }
  const [lo, hi] = wilson(iguales, humanas.length);
  return {
    muestra: humanas.length, suficiente: humanas.length >= UMBRALES_DELEGADOR.muestraMinima, hallazgos: [] as Hallazgo[],
    metricas: { concordancia: proporcion(iguales, humanas.length), concordancia_ic_inf: humanas.length ? Math.round(lo * 1000) / 1000 : null, concordancia_ic_sup: humanas.length ? Math.round(hi * 1000) / 1000 : null },
    detalle: { matriz_humano_vs_karajan: matriz, por_segmento: Object.fromEntries(Object.entries(porSegmento).map(([k, v]) => [k, { ...v, concordancia: proporcion(v.iguales, v.n) }])) },
  };
}

function adecuacion(ctx: ContextoDelegador, tareas: TareaAnonima[]) {
  const U = UMBRALES_DELEGADOR;
  const terminadas = tareas.filter((t) => t.agenteHumano && t.exito !== null);
  const seg: Record<string, { dominio: string; nivel: number; n: number; discrepa: number; discrepaExito: number; exitosHumanos: Record<string, number> }> = {};
  for (const t of terminadas) {
    const p = ctx.planificar(t.prompt);
    const s = (seg[segmento(p)] ??= { dominio: p.clasificacion.domain[0] ?? 'general', nivel: nivelNum(p), n: 0, discrepa: 0, discrepaExito: 0, exitosHumanos: {} });
    s.n++;
    if (t.exito) s.exitosHumanos[t.agenteHumano!] = (s.exitosHumanos[t.agenteHumano!] ?? 0) + 1;
    if (agenteDelPlan(p) !== t.agenteHumano) { s.discrepa++; if (t.exito) s.discrepaExito++; }
  }
  const inadecuados = Object.entries(seg).filter(([, s]) => s.n >= U.segmentoMinimo && wilson(s.discrepa, s.n)[0] > U.discrepanciaWilson && s.discrepa > 0 && s.discrepaExito / s.discrepa >= U.exitoHumano);
  const hallazgos: Hallazgo[] = [];
  if (inadecuados.length) {
    const base = ctx.perfil();
    const nuevo: Perfil = JSON.parse(JSON.stringify(base)) as Perfil;
    nuevo.id = `${base.id}-lab`.slice(0, 80);
    nuevo.name = `${base.name} · ajustado por el laboratorio`.slice(0, 100);
    const reglas: Regla[] = [];
    for (const [k, s] of inadecuados) {
      const agente = Object.entries(s.exitosHumanos).sort((a, b) => b[1] - a[1])[0]?.[0];
      const entidad = nuevo.entities.find((e) => e.provider === agente);
      if (!entidad) continue;
      reglas.push({ id: `lab-${k.replace(/[^\w-]+/g, '-')}`.slice(0, 80), name: `${s.dominio} N${s.nivel} → ${entidad.name ?? entidad.id} (laboratorio)`, entity_id: entidad.id, domains: [s.dominio], intents: [], level_min: s.nivel, level_max: s.nivel, enabled: true });
    }
    nuevo.rules = [...reglas, ...(nuevo.rules ?? [])];
    nuevo['description'] = describirPerfil(nuevo);
    const valido = (() => { try { validarLayout({ profiles: [nuevo], active_profile_id: nuevo.id, default_profile_id: nuevo.id }); return true; } catch { return false; } })();
    if (reglas.length && valido) hallazgos.push({
      clave: 'perfil-inadecuado', severidad: 'media', titulo: `El perfil «${base.name}» no se ajusta a cómo se reparten las tareas en ${inadecuados.map(([k]) => k).join(', ')}`,
      evidencia: inadecuados.map(([k, s]) => `- ${k}: ${s.discrepa}/${s.n} tareas en las que la persona eligió otro agente (IC95 inf. ${wilson(s.discrepa, s.n)[0].toFixed(2)} > ${U.discrepanciaWilson}), y su elección salió bien en ${s.discrepaExito}/${s.discrepa}.`).join('\n'),
      propuesta: `Crear el perfil «${nuevo.name}»: ${String(nuevo['description'])}\n\n\`\`\`json\n${JSON.stringify(nuevo, null, 2)}\n\`\`\`\n\nAplicarlo con \`PUT /routing-layout\` y la cabecera \`x-karajan-tarea\` de esta tarea (como perfil nuevo, sin borrar el actual).`,
      criterios: ['El perfil nuevo se valida y queda como perfil adicional (el actual no se borra).', 'Con él, `kj lab run delegador` deja de dar «perfil-inadecuado» en esos segmentos.'],
    });
  }
  return {
    muestra: terminadas.length, suficiente: Object.values(seg).some((s) => s.n >= U.segmentoMinimo), hallazgos,
    metricas: { segmentos: Object.keys(seg).length, segmentos_evaluables: Object.values(seg).filter((s) => s.n >= U.segmentoMinimo).length, segmentos_inadecuados: inadecuados.length },
    umbrales: { segmento: `n ≥ ${U.segmentoMinimo}`, discrepancia: `IC95 inferior > ${U.discrepanciaWilson}`, exito_humano: `≥ ${U.exitoHumano * 100} % donde discrepa` },
    detalle: { segmentos: Object.fromEntries(Object.entries(seg).map(([k, s]) => [k, { n: s.n, discrepa: s.discrepa, discrepa_y_acierta_persona: s.discrepaExito }])) },
  };
}

function determinismo(ctx: ContextoDelegador, tareas: TareaAnonima[]) {
  let iguales = 0;
  for (const t of tareas) {
    const a = ctx.planificar(t.prompt), b = ctx.planificar(t.prompt);
    const firma = (p: Plan) => JSON.stringify([p.clasificacion.complexity_level, p.clasificacion.domain, p.asignaciones.map((x) => [x.proveedor, x.regla])]);
    if (firma(a) === firma(b)) iguales++;
  }
  const auto = tareas.filter((t) => !t.agenteHumano && t.agenteReal);
  const coincide = auto.filter((t) => agenteDelPlan(ctx.planificar(t.prompt)) === t.agenteReal).length;
  const hallazgos: Hallazgo[] = iguales < tareas.length ? [{
    clave: 'no-determinista', severidad: 'alta', titulo: 'El delegador no da lo mismo para el mismo prompt',
    evidencia: `${tareas.length - iguales} de ${tareas.length} prompts cambian de nivel, dominio o agente entre dos planificaciones seguidas.`,
    propuesta: 'Buscar estado oculto (fecha, aleatoriedad, caché de disponibilidad) en la clasificación o en `asignar`.',
  }] : [];
  return {
    muestra: tareas.length, suficiente: tareas.length > 0, hallazgos,
    metricas: { estabilidad: proporcion(iguales, tareas.length), auto_n: auto.length, auto_igual_que_entonces: proporcion(coincide, auto.length) },
    umbrales: { estabilidad: '= 1' },
  };
}

export const laboratorioDelegador: Laboratorio<ContextoDelegador> = {
  escenarios: [
    { id: 'fidelidad', tipo: 'contrato', descripcion: 'Cada decisión sale de una regla o un nivel del perfil; reglas tapadas o sin uso; niveles sin agente', ejecutar: async (c) => fidelidad(c, await c.tareas()) },
    { id: 'concordancia', tipo: 'replay', descripcion: 'A ciegas: el agente que elige Karajan frente al que eligió la persona', ejecutar: async (c) => concordancia(c, await c.tareas()) },
    { id: 'adecuacion', tipo: 'replay', descripcion: 'Por dominio×nivel: si la persona acierta donde el perfil la contradice, se propone un perfil nuevo', ejecutar: async (c) => adecuacion(c, await c.tareas()) },
    { id: 'determinismo', tipo: 'contrato', descripcion: 'El mismo prompt da el mismo plan; y las tareas «auto» siguen yendo al mismo agente', ejecutar: async (c) => determinismo(c, await c.tareas()) },
  ],
};
