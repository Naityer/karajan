import { familiaDe, validarCombinacion, type Actor, type Esfuerzo, type Modificador, type ModoBase, type NivelModelo, type PeticionActor, type SolicitudModo } from './planificador-modos';
import { CONFIG_POR_DEFECTO, type ConfigPlanificador } from './planificador-registro';

/**
 * Planificador: dado una tarea ya clasificada y el modo pedido, construye SIEMPRE un plan —quién hace qué, en qué orden, con qué
 * entregable y cómo se valida— y, en `auto`, elige además el formato (classic, single-agent, master-slave o co-work) comparando
 * coste, tiempo y riesgo. Es una función pura: no lanza ningún agente ni lee el disco. Las métricas (coste del dosificador, acierto
 * de producción, estado de la cuota) entran por `ContextoPlanificador`; si falta un dato, el plan lo dice y usa un prior en su sitio.
 * Quien ejecuta el plan es la cola de Atlas dev (ver docs/laboratorio/componentes.md).
 */
export interface UnidadTarea { nombre: string; validacion?: string; complejidad?: number }
export interface TareaClasificada { nivel: number; dominio: string[]; subtareas: UnidadTarea[] }
export interface EntradaPlanificar { solicitud: SolicitudModo; tarea: TareaClasificada; /** Agente que el delegador eligió para la tarea; es el principal si la solicitud no da otro. */ agente?: string }

export type Fuente = 'observado' | 'mezcla' | 'prior';
export interface ContextoPlanificador {
  config: ConfigPlanificador;
  /** Coste esperado de la tarea completa en % del plan semanal con el modelo de referencia (superior), y de dónde sale. `null` si no hay dato. */
  coste?(agente: string, nivel: number, dominio: string): { pct: number; fuente: Fuente } | null;
  /** Acierto observado (0-1, de producción) de un agente y su muestra. */
  acierto?(agente: string): { valor: number; n: number } | null;
  /** Estado de la cuota según el dosificador. `bloqueado`/`frenado` empujan hacia agentes baratos. */
  cuota?(): { modo: 'normal' | 'frenado' | 'bloqueado' } | null;
  disponible?(agente: string): boolean;
  ahora?(): Date;
}

export type TipoPaso = 'trabajo' | 'integracion' | 'sintesis' | 'checker' | 'jefe';
export interface Paso { id: string; titulo: string; tipo: TipoPaso; actor: string; entregable: string; validacion: string; hito: string | null; depende: string[]; bajoDemanda?: boolean }
export interface Hito { id: string; objetivo: string; entregable: string; validacion: string; pasos: string[] }
export interface Alternativa { modo: ModoBase; modificadores: Modificador[]; coste: number; tiempo: number; riesgo: number; puntuacion: number }
export interface PlanEjecucion {
  version: 1; modo: ModoBase; solicitado: ModoBase; modificadores: Modificador[]; nivel: number; dominio: string[];
  actores: Record<string, Actor>; pasos: Paso[]; hitos: Hito[];
  checker: { actor: string; criterios: string[] } | null;
  jefe: { actor: string; candidatos: string[]; intervencionMin: number; disparadores: string[] } | null;
  repoComun: boolean; avisos: string[]; errores: string[]; motivo: string; alternativas: Alternativa[];
  metricas: { coste: Fuente | 'sin-dato'; acierto: Fuente | 'sin-dato'; cuota: string; estimacion: { coste: number; tiempo: number; riesgo: number } | null };
  generado: string;
}

const PRIOR_PCT = [0.5, 1, 2, 4, 8];
const PRIOR_EXITO: Record<NivelModelo, number> = { superior: 0.9, medio: 0.8, bajo: 0.65 };
const MULT_ESFUERZO: Record<Esfuerzo, number> = { bajo: 0.7, medio: 1, alto: 1.3 };
const SIMPLE = /\b(test|tests|prueba|pruebas|doc|docs|documentaci[oó]n|readme|lint|format|formato|coment|changelog)\w*/i;
const redondear = (n: number) => Math.round(n * 1000) / 1000;
const ACOTA = (n: number) => Math.min(5, Math.max(1, Math.round(n)));

/** Misma familia que el principal si hay un agente activo de ella; si no, el primero activo distinto, con aviso. */
export function sugerirSubagente(principal: string, ctx: ContextoPlanificador, nivel: NivelModelo = 'medio'): { agente: string; nivel: NivelModelo; aviso?: string } {
  const activos = agentesActivos(ctx), fam = familiaDe(principal);
  const misma = activos.find((a) => familiaDe(a) === fam);
  if (misma) return { agente: misma, nivel };
  const otro = activos.find((a) => a !== principal) ?? principal;
  return { agente: otro, nivel, aviso: `No hay un agente activo de la familia ${fam}: el subagente será ${otro}.` };
}

const agentesActivos = (ctx: ContextoPlanificador) => Object.entries(ctx.config.agentes).filter(([a, v]) => v.activo && (ctx.disponible?.(a) ?? true)).map(([a]) => a);

function nivelPorTarea(nivel: number): NivelModelo { return nivel >= 4 ? 'superior' : nivel >= 2 ? 'medio' : 'bajo'; }

function actor(ctx: ContextoPlanificador, id: string, agente: string, nivel: NivelModelo, esfuerzo: Esfuerzo, p?: PeticionActor, ambito?: string): Actor {
  return { id, agente, nivel: p?.nivel ?? nivel, modelo: p?.modelo ?? null, preferencia: ctx.config.agentes[agente]?.niveles[p?.nivel ?? nivel] ?? [], esfuerzo: p?.esfuerzo ?? esfuerzo, ...((p?.ambito ?? ambito) ? { ambito: p?.ambito ?? ambito } : {}) };
}

interface Borrador { actores: Record<string, Actor>; pasos: Paso[]; hitos: Hito[]; checker: PlanEjecucion['checker']; jefe: PlanEjecucion['jefe']; repoComun: boolean; avisos: string[] }
interface Unidad { titulo: string; validacion: string; entregable: string; actor: string; complejidad: number; ambito?: string }

/** Arma el plan de UN formato concreto (nunca `auto`). */
function armar(modo: Exclude<ModoBase, 'auto'>, mods: Modificador[], e: EntradaPlanificar, ctx: ContextoPlanificador, principal: string): Borrador {
  const cfg = ctx.config, nivel = ACOTA(e.tarea.nivel), lazy = mods.includes('lazy-agent'), avisos: string[] = [];
  const nivelPrincipal: NivelModelo = e.solicitud.principal?.nivel ?? (modo === 'master-slave' || modo === 'co-work' ? 'superior' : lazy ? 'bajo' : nivelPorTarea(nivel));
  const esfPrincipal: Esfuerzo = nivel >= 4 ? 'alto' : nivel >= 2 ? 'medio' : 'bajo';
  const actores: Record<string, Actor> = { principal: actor(ctx, 'principal', principal, nivelPrincipal, esfPrincipal, e.solicitud.principal) };
  const base: UnidadTarea[] = e.tarea.subtareas.length ? e.tarea.subtareas.slice(0, 8) : [{ nombre: 'Completar la tarea', validacion: 'La tarea cumple lo pedido y sus pruebas pasan' }];
  const unidad = (u: UnidadTarea, act: string, ambito?: string): Unidad => ({ titulo: ambito ? `${u.nombre} (${ambito})` : u.nombre, validacion: u.validacion || 'El resultado cumple el objetivo del paso', entregable: `Cambios de «${u.nombre}» en el repositorio`, actor: act, complejidad: u.complejidad ?? 1, ...(ambito ? { ambito } : {}) });
  let unidades: Unidad[] = [], paralelo = false, integra = false, jefe: Borrador['jefe'] = null;

  if (modo === 'classic') {
    unidades = mods.includes('milestone') ? base.map((u) => unidad(u, 'principal')) : [{ titulo: 'Completar la tarea', validacion: base.map((u) => u.validacion).filter(Boolean).join(' · ') || 'La tarea cumple lo pedido y sus pruebas pasan', entregable: 'Tarea completa en el repositorio', actor: 'principal', complejidad: nivel }];
  } else if (modo === 'single-agent') {
    unidades = base.map((u) => unidad(u, 'principal'));
    const pedidos = (e.solicitud.subagentes ?? []).slice(0, 1);
    // Un subagente solo si hay algo complementario y sencillo (o la persona lo pidió): el más barato de los candidatos.
    const candidato = unidades.length >= 2 ? [...unidades].sort((a, b) => a.complejidad - b.complejidad).find((u) => pedidos.length || SIMPLE.test(u.titulo)) : undefined;
    if (candidato) {
      const s = sugerirSubagente(principal, ctx, 'bajo');
      actores['sub1'] = actor(ctx, 'sub1', pedidos[0]?.agente ?? s.agente, 'bajo', 'bajo', pedidos[0]);
      if (!pedidos[0]?.agente && s.aviso) avisos.push(s.aviso);
      candidato.actor = 'sub1';
    } else if (pedidos.length) avisos.push('single-agent: no hay una tarea complementaria sencilla, así que no se usa el subagente pedido.');
  } else if (modo === 'master-slave') {
    const pedidos = e.solicitud.subagentes ?? [];
    const n = pedidos.length || Math.min(cfg.maxSubagentes, 3, Math.max(1, base.length - 1));
    for (let i = 0; i < Math.min(n, cfg.maxSubagentes); i++) {
      const p = pedidos[i], s = sugerirSubagente(principal, ctx, lazy ? 'bajo' : 'medio');
      actores[`sub${i + 1}`] = actor(ctx, `sub${i + 1}`, p?.agente ?? s.agente, lazy ? 'bajo' : 'medio', lazy ? 'bajo' : 'medio', p);
      if (!p?.agente && s.aviso && !avisos.includes(s.aviso)) avisos.push(s.aviso);
    }
    if (pedidos.length > cfg.maxSubagentes) avisos.push(`Se usan ${cfg.maxSubagentes} subagentes (máximo configurado), no los ${pedidos.length} pedidos.`);
    const subs = Object.keys(actores).filter((k) => k !== 'principal');
    unidades = base.map((u, i) => unidad(u, subs[i % subs.length]!));
    paralelo = true; integra = true;
  } else {
    // co-work: especialistas por ámbito; el principal es el primero y coordina; el jefe frontera interviene puntualmente.
    const pedidos = e.solicitud.subagentes ?? [], dominio = e.tarea.dominio[0] ?? 'default';
    const ambitos = cfg.ambitos[dominio] ?? cfg.ambitos['default']!;
    const total = Math.min(cfg.maxSubagentes + 1, Math.max(2, pedidos.length ? pedidos.length + 1 : ambitos.length));
    const activos = agentesActivos(ctx), pos = Math.max(0, activos.indexOf(principal));
    actores['principal'] = actor(ctx, 'principal', principal, nivelPrincipal, esfPrincipal, e.solicitud.principal, e.solicitud.principal?.ambito ?? ambitos[0]);
    for (let i = 1; i < total; i++) {
      const p = pedidos[i - 1], ag = p?.agente ?? activos[(pos + i) % activos.length] ?? principal;
      actores[`sub${i}`] = actor(ctx, `sub${i}`, ag, 'medio', 'medio', p, p?.ambito ?? ambitos[i % ambitos.length]);
    }
    if (activos.length < 2 && !pedidos.length) avisos.push('Solo hay un agente activo: los especialistas de co-work comparten familia; activa otro agente para diversificar.');
    const esp = Object.values(actores), cuantas = Math.max(base.length, esp.length);
    unidades = Array.from({ length: cuantas }, (_, i) => {
      const a = esp[i % esp.length]!, u = base[i] ?? { nombre: `Parte de ${a.ambito ?? 'la tarea'}`, validacion: `El trabajo de ${a.ambito ?? 'esta parte'} se integra sin conflictos` };
      return unidad(u, a.id, a.ambito);
    });
    paralelo = true; integra = true;
    actores['jefe'] = { id: 'jefe', agente: principal, nivel: 'superior', modelo: null, preferencia: cfg.jefe.referencia, esfuerzo: 'alto' };
    jefe = { actor: 'jefe', candidatos: cfg.jefe.referencia, intervencionMin: cfg.jefe.intervencionMin, disparadores: ['conflicto entre especialistas', 'bloqueo', 'desvío del objetivo'] };
  }

  // Hitos: grupos contiguos de unidades con síntesis (compactar, recapitular) entre uno y el siguiente.
  const pasos: Paso[] = [], hitos: Hito[] = [];
  const nId = () => `p${pasos.length + 1}`;
  const grupos: Unidad[][] = [];
  if (mods.includes('milestone')) {
    let fuente = unidades;
    if (fuente.length < 2) fuente = ['Entender y diseñar', 'Implementar', 'Verificar'].map((t) => ({ ...unidades[0]!, titulo: t, entregable: `${t}: entregable verificable`, validacion: `«${t}» queda comprobado antes de seguir` }));
    const h = Math.min(fuente.length, nivel >= 4 ? 5 : 3), tam = Math.ceil(fuente.length / h);
    for (let i = 0; i < fuente.length; i += tam) grupos.push(fuente.slice(i, i + tam));
  } else grupos.push(unidades);
  let previo: string[] = [];
  grupos.forEach((g, gi) => {
    const hid = mods.includes('milestone') ? `h${gi + 1}` : null, ids: string[] = [];
    g.forEach((u) => {
      const id = nId(), dep = paralelo ? previo : [...(ids.length ? [ids[ids.length - 1]!] : previo)];
      pasos.push({ id, titulo: u.titulo, tipo: 'trabajo', actor: u.actor, entregable: u.entregable, validacion: u.validacion, hito: hid, depende: dep });
      ids.push(id);
    });
    let cierre = ids[ids.length - 1]!;
    if (integra) { cierre = nId(); pasos.push({ id: cierre, titulo: hid ? `Integrar y validar el hito ${gi + 1}` : 'Integrar y validar', tipo: 'integracion', actor: 'principal', entregable: 'Trabajo integrado en la rama común y comprobado', validacion: 'Sin conflictos y con las pruebas del repositorio en verde', hito: hid, depende: ids }); }
    if (hid) {
      hitos.push({ id: hid, objetivo: g.map((u) => u.titulo).join(' · ').slice(0, 300), entregable: g.map((u) => u.entregable).join('; ').slice(0, 400), validacion: g.map((u) => u.validacion).join(' · ').slice(0, 400), pasos: [...ids, ...(integra ? [cierre] : [])] });
      if (gi < grupos.length - 1) { const s = nId(); pasos.push({ id: s, titulo: `Compactar y sintetizar tras el hito ${gi + 1}`, tipo: 'sintesis', actor: 'principal', entregable: 'Resumen de lo hecho, decisiones y pendientes para el hito siguiente', validacion: 'El hito siguiente puede arrancar solo con ese resumen', hito: hid, depende: [cierre] }); cierre = s; hitos[hitos.length - 1]!.pasos.push(s); }
    }
    previo = [cierre];
  });
  if (jefe) pasos.push({ id: nId(), titulo: `Intervención del jefe frontera (${cfg.jefe.intervencionMin} min)`, tipo: 'jefe', actor: 'jefe', entregable: 'Decisión que resuelve el conflicto o redirige el trabajo', validacion: `Dura como máximo ${cfg.jefe.intervencionMin} minutos y deja la decisión escrita`, hito: null, depende: [], bajoDemanda: true });

  let checker: Borrador['checker'] = null;
  if (mods.includes('checker')) {
    const pc = typeof e.solicitud.checker === 'object' ? e.solicitud.checker : undefined, s = sugerirSubagente(principal, ctx, 'bajo');
    actores['checker'] = actor(ctx, 'checker', pc?.agente ?? s.agente, 'bajo', 'bajo', pc);
    if (!pc?.agente && s.aviso && !avisos.includes(s.aviso)) avisos.push(s.aviso);
    checker = { actor: 'checker', criterios: ['errores', 'bugs', 'trabajo pendiente'] };
    pasos.push({ id: nId(), titulo: 'Revisión final del checker', tipo: 'checker', actor: 'checker', entregable: 'Informe de errores, bugs y trabajo pendiente', validacion: 'Cada hallazgo con severidad y evidencia; sin hallazgos solo si de verdad no hay', hito: null, depende: previo });
  }
  return { actores, pasos, hitos, checker, jefe, repoComun: true, avisos };
}

/** Todas observadas → observado; todas priors → prior; mezcla en otro caso; sin ninguna → sin-dato. */
const resumirFuente = (fs: Fuente[]): Fuente | 'sin-dato' => (!fs.length ? 'sin-dato' : fs.every((f) => f === 'observado') ? 'observado' : fs.every((f) => f === 'prior') ? 'prior' : 'mezcla');

/** Estima coste (relativo al modelo superior = 1 unidad de la tarea), tiempo (camino crítico) y riesgo (1 − acierto) de un plan armado. */
function estimarPlan(b: Borrador, modo: ModoBase, mods: Modificador[], nivel: number, dominio: string, ctx: ContextoPlanificador) {
  const cfg = ctx.config, trabajo = b.pasos.filter((p) => p.tipo === 'trabajo').length || 1;
  const cuota = (p: Paso) => (p.tipo === 'trabajo' ? (b.pasos.some((x) => x.tipo === 'integracion') ? 0.8 : 1) / trabajo : p.tipo === 'integracion' ? 0.15 : p.tipo === 'sintesis' ? 0.03 : p.tipo === 'checker' ? 0.05 : 0);
  const fuentesCoste: Fuente[] = [], fuentesAcierto: Fuente[] = [];
  let coste = 0, exitoPonderado = 0, peso = 0;
  const fijos = b.pasos.filter((p) => !p.bajoDemanda);
  for (const p of fijos) {
    const a = b.actores[p.actor]!, c = ctx.coste?.(a.agente, nivel, dominio);
    fuentesCoste.push(c?.fuente ?? 'prior');
    const pct = c?.pct ?? PRIOR_PCT[nivel - 1]!;
    coste += cuota(p) * cfg.pesoNivel[a.nivel] * pct * MULT_ESFUERZO[a.esfuerzo];
    if (p.tipo === 'trabajo') {
      const ac = ctx.acierto?.(a.agente), observado = ac && ac.n >= 5;
      fuentesAcierto.push(observado ? 'observado' : 'prior');
      const dificultad = a.nivel === 'superior' ? 0 : (a.nivel === 'medio' ? 0.06 : 0.1) * Math.max(0, nivel - 2);
      exitoPonderado += cuota(p) * Math.max(0.05, (observado ? ac!.valor : PRIOR_EXITO[a.nivel]) - dificultad);
      peso += cuota(p);
    }
  }
  const sobrecoste = (modo === 'master-slave' ? 1.15 : modo === 'co-work' ? 1.35 : 1) * (mods.includes('milestone') ? 1.1 : 1);
  // Tiempo: camino crítico con 0,04 de coste fijo por paso (arranque, contexto); los modelos bajos y el modo lazy son más lentos.
  const dur = new Map<string, number>(), por = new Map(b.pasos.map((p) => [p.id, p]));
  const fin = (id: string): number => { if (dur.has(id)) return dur.get(id)!; const p = por.get(id)!; const d = (p.bajoDemanda ? 0 : cuota(p) + 0.04) * (b.actores[p.actor]!.nivel === 'bajo' ? 1.3 : 1) * (mods.includes('lazy-agent') ? 1.15 : 1); const r = d + Math.max(0, ...p.depende.map(fin)); dur.set(id, r); return r; };
  const tiempo = Math.max(...fijos.map((p) => fin(p.id)), 0.04);
  const bono = (modo === 'master-slave' ? 0.05 : modo === 'co-work' ? 0.07 : 0) + (mods.includes('milestone') ? 0.04 : 0) + (mods.includes('checker') ? 0.03 : 0);
  const riesgo = 1 - Math.min(0.98, (peso ? exitoPonderado / peso : PRIOR_EXITO.medio) + bono);
  return { coste: redondear(coste * sobrecoste), tiempo: redondear(tiempo), riesgo: redondear(riesgo), fuenteCoste: resumirFuente(fuentesCoste), fuenteAcierto: resumirFuente(fuentesAcierto) };
}

/** Plan vacío con errores: la entrada era inválida y no se ejecuta nada. */
const rechazado = (e: EntradaPlanificar, errores: string[], avisos: string[], ahora: Date): PlanEjecucion => ({
  version: 1, modo: 'classic', solicitado: (typeof e.solicitud?.modo === 'string' ? e.solicitud.modo : 'classic') as ModoBase, modificadores: [], nivel: ACOTA(e.tarea?.nivel ?? 1), dominio: e.tarea?.dominio ?? [], actores: {}, pasos: [], hitos: [], checker: null, jefe: null,
  repoComun: false, avisos, errores, motivo: `Plan rechazado: ${errores.join(' · ')}`, alternativas: [], metricas: { coste: 'sin-dato', acierto: 'sin-dato', cuota: 'sin-dato', estimacion: null }, generado: ahora.toISOString(),
});

export function planificar(e: EntradaPlanificar, ctx: ContextoPlanificador): PlanEjecucion {
  const ahora = ctx.ahora?.() ?? new Date(), cfg = ctx.config ?? CONFIG_POR_DEFECTO;
  const v = validarCombinacion(e.solicitud);
  if (!v.ok) return rechazado(e, v.errores, v.avisos, ahora);
  const avisos = [...v.avisos], activos = agentesActivos(ctx);
  if (!activos.length) return rechazado(e, ['No hay ningún agente activo y disponible para planificar.'], avisos, ahora);
  let principal = e.solicitud.principal?.agente ?? e.agente ?? activos[0]!;
  if (!activos.includes(principal)) { avisos.push(`El agente ${principal} no está activo o disponible: el principal será ${activos[0]}.`); principal = activos[0]!; }
  const nivel = ACOTA(e.tarea.nivel), dominio = e.tarea.dominio[0] ?? 'general', cuota = ctx.cuota?.() ?? null;
  let mods = [...v.modificadores];

  let modo: Exclude<ModoBase, 'auto'>;
  let alternativas: Alternativa[] = [], motivo: string;
  if (v.modo !== 'auto') { modo = v.modo; motivo = `Modo ${modo} pedido por la persona${mods.length ? ` con ${mods.join(' + ')}` : ''}.`; }
  else {
    // Auto: primero el plan base con el agente elegido, luego la comparación de formatos con las métricas disponibles.
    if (!mods.includes('milestone') && nivel >= cfg.hitosDesdeNivel) { mods.push('milestone'); avisos.push(`auto añade milestone: la tarea es de nivel ${nivel} (umbral ${cfg.hitosDesdeNivel}).`); }
    if (!mods.includes('lazy-agent') && cuota && cuota.modo !== 'normal') { mods.push('lazy-agent'); avisos.push(`auto añade lazy-agent: la cuota está en modo ${cuota.modo}.`); }
    if (!mods.includes('checker') && nivel >= 4) avisos.push('Tarea compleja: considera asignar un checker.');
    const candidatos: Exclude<ModoBase, 'auto'>[] = ['classic', 'single-agent', 'master-slave'];
    if (!mods.includes('lazy-agent') && nivel >= 4 && (e.tarea.dominio.length >= 2 || activos.length >= 2)) candidatos.push('co-work');
    const w = { ...cfg.pesos, coste: cfg.pesos.coste * (cuota?.modo === 'frenado' ? 2 : 1) };
    const calc = candidatos.map((m) => { const b = armar(m, mods, e, ctx, principal); return { m, ...estimarPlan(b, m, mods, nivel, dominio, ctx) }; });
    const maxC = Math.max(...calc.map((c) => c.coste), 1e-9), maxT = Math.max(...calc.map((c) => c.tiempo), 1e-9), suma = (w.coste + w.tiempo + w.riesgo) || 1;
    const puntuado = calc.map((c) => ({ ...c, puntuacion: redondear((w.coste * (c.coste / maxC) + w.tiempo * (c.tiempo / maxT) + w.riesgo * c.riesgo) / suma) })).sort((a, b) => a.puntuacion - b.puntuacion);
    alternativas = puntuado.map((c) => ({ modo: c.m, modificadores: mods, coste: c.coste, tiempo: c.tiempo, riesgo: c.riesgo, puntuacion: c.puntuacion }));
    modo = puntuado[0]!.m;
    const g = puntuado[0]!, otro = puntuado[1];
    const datos = `coste ${g.fuenteCoste}, acierto ${g.fuenteAcierto}`;
    motivo = `Auto eligió ${modo} (puntuación ${g.puntuacion}: coste ${g.coste}, tiempo ${g.tiempo}, riesgo ${g.riesgo})${otro ? ` frente a ${otro.m} (${otro.puntuacion})` : ''}; datos: ${datos}${cuota ? `, cuota ${cuota.modo}` : ''}.`;
    if (g.fuenteCoste !== 'observado' || g.fuenteAcierto !== 'observado') avisos.push('La decisión de auto usa priors donde faltan métricas observadas: es una estimación, no una medición.');
  }
  const b = armar(modo, mods, e, ctx, principal), est = estimarPlan(b, modo, mods, nivel, dominio, ctx);
  return {
    version: 1, modo, solicitado: v.modo, modificadores: mods, nivel, dominio: e.tarea.dominio, actores: b.actores, pasos: b.pasos, hitos: b.hitos, checker: b.checker, jefe: b.jefe,
    repoComun: b.repoComun, avisos: [...avisos, ...b.avisos], errores: [], motivo, alternativas,
    metricas: { coste: est.fuenteCoste, acierto: est.fuenteAcierto, cuota: cuota?.modo ?? 'sin-dato', estimacion: { coste: est.coste, tiempo: est.tiempo, riesgo: est.riesgo } }, generado: ahora.toISOString(),
  };
}
