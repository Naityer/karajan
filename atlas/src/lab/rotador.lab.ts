import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Hallazgo } from '../pasarela-borradores';
import { proporcion, wilson, type ContextoLab, type Laboratorio, type Resultado } from '../laboratorio';
import { Rotador, simularRotacion, type ConfigRotador, type HistorialUso, type ResultadoSimulacion } from '../rotador';

/**
 * Laboratorio del rotador. Dos preguntas:
 *   contrato  ¿la configuración y el plan actual son coherentes? (instantánea < núcleo < frecuente; las protegidas no se retiran;
 *             nada está instalado y en el almacén a la vez; aplicar el plan en una casa ficticia y recalcular da un plan vacío)
 *   replay    con el HISTORIAL de usos (Atlas dev `dias`, ejecuciones de Karajan con su fecha) reproducido día a día en un sandbox,
 *             ¿qué días de núcleo y frecuente habrían dado menos fallos (la skill hacía falta y estaba en el almacén) o menos
 *             skills instaladas (coste de contexto)? Solo se propone cambiar con muestra suficiente y mejora clara.
 * Nada toca las carpetas reales: todo lo que se mueve vive en un directorio temporal que se borra al terminar.
 */
export interface ContextoRotador extends ContextoLab {
  /** El rotador real: aquí solo se lee (inventario, plan, estado, usos). */
  rotador: Rotador;
  historial(): HistorialUso;
  ahora(): number;
}

export const UMBRALES_ROTADOR = {
  /** Días iniciales que no puntúan (el estado de partida es «todo instalado»): el mayor `frecuenteDias` de la rejilla. */
  calentamiento: 60,
  /** Días de historial puntuables, además del calentamiento. */
  diasEvaluacionMin: 30,
  /** Usos (skill × día) dentro de los días puntuables. */
  usosMin: 40,
  /** Mejora relativa mínima para llamarla clara, y empeoramiento relativo tolerado en el otro eje. */
  mejoraMin: 0.15,
  margen: 0.05,
  fallosMinimos: 3,
};
const REJILLA = { nucleo: [7, 14, 21], frecuente: [30, 45, 60] };
const DIA = 86_400_000;
const dia = (fecha: string) => Math.floor(Date.parse(`${fecha.slice(0, 10)}T00:00:00Z`) / DIA);
const sinProtegidas = (h: HistorialUso, protegidas: string[]): HistorialUso => Object.fromEntries(Object.entries(h).filter(([s]) => !protegidas.includes(s)));

/** Una casa ficticia con el mismo reparto de skills (carpetas vacías con SKILL.md) y el mismo estado que el rotador real. */
function casaFicticia(ctx: ContextoRotador, dir: string): Rotador {
  const e = ctx.rotador.leerEstado();
  writeFileSync(join(dir, 'rotador.json'), JSON.stringify(e), 'utf8');
  const ficticio = new Rotador({ casa: dir, estado: join(dir, 'rotador.json'), usoAtlas: join(dir, 'sin-uso.json'), usosKarajan: () => ctx.rotador.ultimosUsos(), ahora: ctx.ahora });
  for (const f of ctx.rotador.inventario()) {
    for (const d of f.instaladaEn) crearSkill(join(ficticio.raiz(d), f.skill));
    for (const d of f.enAlmacen) crearSkill(join(ficticio.almacen(d), f.skill));
  }
  return ficticio;
}
function crearSkill(ruta: string) { mkdirSync(ruta, { recursive: true }); writeFileSync(join(ruta, 'SKILL.md'), '---\nname: ficticia\n---\n', 'utf8'); }

function contrato(ctx: ContextoRotador): Resultado {
  const e = ctx.rotador.leerEstado();
  const c = e.config;
  const inventario = ctx.rotador.inventario();
  const plan = ctx.rotador.plan();
  const hallazgos: Hallazgo[] = [];
  const coherente = [c.instantaneaDias, c.nucleoDias, c.frecuenteDias].every((n) => Number.isFinite(n) && n > 0) && c.instantaneaDias < c.nucleoDias && c.nucleoDias < c.frecuenteDias;
  if (!coherente) hallazgos.push({
    clave: 'config-incoherente', severidad: 'alta', titulo: 'Los días del rotador no cumplen instantánea < núcleo < frecuente',
    evidencia: `rotador.json da instantánea ${c.instantaneaDias}, núcleo ${c.nucleoDias} y frecuente ${c.frecuenteDias}: con ese orden un nivel queda tapado por otro.`,
    propuesta: 'Corregir `config` en rotador.json para que sean números positivos y estén en ese orden (por defecto 3 < 14 < 45).',
  });
  const protegidasRetiradas = plan.retirar.filter((r) => c.protegidas.includes(r.skill));
  if (protegidasRetiradas.length) hallazgos.push({
    clave: 'protegida-en-plan', severidad: 'alta', titulo: 'El plan retiraría skills protegidas',
    evidencia: `En el plan de retirar: ${protegidasRetiradas.map((r) => `${r.skill} (${r.destino})`).join(', ')}.`,
    propuesta: 'Revisar `plan` en `atlas/src/rotador.ts`: una protegida no puede salir nunca del plan de retirar.',
  });
  const duplicadas = inventario.flatMap((f) => f.instaladaEn.filter((d) => f.enAlmacen.includes(d)).map((d) => `${f.skill} (${d})`));
  if (duplicadas.length) hallazgos.push({
    clave: 'instalada-y-en-almacen', severidad: 'media', titulo: `${duplicadas.length} skills están instaladas y en el almacén del mismo destino`,
    evidencia: `Duplicadas: ${duplicadas.slice(0, 30).join(', ')}${duplicadas.length > 30 ? '…' : ''}. Retirar sobrescribiría la copia del almacén.`,
    propuesta: 'Decidir cuál es la buena de cada una y quitar la otra a mano (el rotador mueve, no borra).',
  });
  // Idempotencia: aplicar el plan en una copia y recalcular debe dar un plan vacío.
  const dir = mkdtempSync(join(tmpdir(), 'kj-rotador-contrato-'));
  let restante = 0;
  try {
    const ficticio = casaFicticia(ctx, dir);
    ficticio.aplicar();
    const otra = ficticio.plan();
    restante = otra.retirar.length + otra.reponer.length;
    if (restante) hallazgos.push({
      clave: 'plan-no-idempotente', severidad: 'alta', titulo: 'Aplicar el plan del rotador no lo deja en reposo',
      evidencia: `Aplicado en una casa ficticia, el plan vuelve a pedir ${otra.retirar.length} retiradas y ${otra.reponer.length} reposiciones: ${[...otra.retirar, ...otra.reponer].slice(0, 10).map((r) => `${r.skill} (${r.destino})`).join(', ')}.`,
      propuesta: 'Revisar `aplicar` y `plan` en `atlas/src/rotador.ts`: lo que el plan mueve no debe volver a aparecer en el plan siguiente.',
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return {
    muestra: inventario.length, suficiente: inventario.length > 0, hallazgos,
    metricas: { skills: inventario.length, config_coherente: coherente ? 1 : 0, protegidas_en_plan: protegidasRetiradas.length, instaladas_y_en_almacen: duplicadas.length, plan_retirar: plan.retirar.length, plan_reponer: plan.reponer.length, plan_tras_aplicar: restante },
    umbrales: { config: 'instantánea < núcleo < frecuente', protegidas_en_plan: '= 0', instaladas_y_en_almacen: '= 0', plan_tras_aplicar: '= 0 (idempotente)' },
  };
}

/** Reproduce el historial con el `Rotador` de verdad en una casa temporal con `ahora` simulado. Un día = un plan aplicado y los usos del día. */
export function reproducirEnSandbox(historial: HistorialUso, config: ConfigRotador, calentamiento: number): ResultadoSimulacion {
  const r: ResultadoSimulacion = { dias: 0, usos: 0, fallos: 0, instaladasMedia: 0, movimientos: 0 };
  const skills = Object.keys(historial);
  const dias = skills.flatMap((s) => Object.keys(historial[s]!).map(dia));
  if (!dias.length) return r;
  const dir = mkdtempSync(join(tmpdir(), 'kj-rotador-replay-'));
  try {
    writeFileSync(join(dir, 'rotador.json'), JSON.stringify({ config }), 'utf8');
    let ahora = 0;
    const ultimos: Record<string, string> = {};
    const rot = new Rotador({ casa: dir, estado: join(dir, 'rotador.json'), usoAtlas: join(dir, 'sin-uso.json'), usosKarajan: () => ultimos, ahora: () => ahora });
    for (const s of skills) crearSkill(join(rot.raiz('claude'), s));
    const ini = Math.min(...dias), fin = Math.max(...dias);
    let suma = 0;
    for (let d = ini; d <= fin; d++) {
      const puntua = d - ini >= calentamiento;
      ahora = d * DIA;
      const hecho = rot.aplicar();
      if (puntua) r.movimientos += hecho.retirar.length + hecho.reponer.length;
      for (const s of skills) {
        const fecha = new Date(d * DIA).toISOString().slice(0, 10);
        if (!historial[s]![fecha]) continue;
        if (puntua) r.usos++;
        if (rot.asegurar(s, 'claude').repuesta && puntua) { r.fallos++; r.movimientos++; }
        ultimos[s] = new Date(d * DIA).toISOString();
      }
      if (puntua) { r.dias++; suma += readdirSync(rot.raiz('claude')).length; }
    }
    r.instaladasMedia = r.dias ? Math.round((suma / r.dias) * 100) / 100 : 0;
    return r;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const igual = (a: ResultadoSimulacion, b: ResultadoSimulacion) => a.dias === b.dias && a.usos === b.usos && a.fallos === b.fallos && a.instaladasMedia === b.instaladasMedia && a.movimientos === b.movimientos;

/** ¿Es `cand` una mejora clara sobre `base`? En ambos ejes, o en uno sin empeorar el otro más del margen. */
export function mejoraClara(cand: ResultadoSimulacion, base: ResultadoSimulacion): boolean {
  const U = UMBRALES_ROTADOR;
  const mejoraFallos = base.fallos - cand.fallos >= U.fallosMinimos && base.fallos - cand.fallos >= base.fallos * U.mejoraMin;
  const mejoraCoste = base.instaladasMedia - cand.instaladasMedia >= 1 && base.instaladasMedia - cand.instaladasMedia >= base.instaladasMedia * U.mejoraMin;
  const peorFallos = cand.fallos - base.fallos > base.fallos * U.margen;
  const peorCoste = cand.instaladasMedia - base.instaladasMedia > base.instaladasMedia * U.margen;
  return (mejoraFallos && !peorCoste) || (mejoraCoste && !peorFallos);
}

function replay(ctx: ContextoRotador): Resultado {
  const U = UMBRALES_ROTADOR;
  const config = ctx.rotador.leerEstado().config;
  const historial = sinProtegidas(ctx.historial(), config.protegidas);
  const fechas = Object.values(historial).flatMap((f) => Object.keys(f).map(dia));
  const diasHistorial = fechas.length ? Math.max(...fechas) - Math.min(...fechas) + 1 : 0;
  const actual = simularRotacion(historial, config, U.calentamiento);
  const suficiente = diasHistorial >= U.calentamiento + U.diasEvaluacionMin && actual.usos >= U.usosMin;
  const hallazgos: Hallazgo[] = [];
  const tasa = (r: ResultadoSimulacion) => proporcion(r.fallos, r.usos);
  const [lo, hi] = wilson(actual.fallos, actual.usos);
  const metricas: Resultado['metricas'] = {
    dias_historial: diasHistorial, skills_con_uso: Object.keys(historial).length, usos_evaluados: actual.usos, fallos: actual.fallos, tasa_fallos: tasa(actual),
    tasa_fallos_ic_inf: actual.usos ? Math.round(lo * 1000) / 1000 : null, tasa_fallos_ic_sup: actual.usos ? Math.round(hi * 1000) / 1000 : null,
    instaladas_media: actual.instaladasMedia, movimientos: actual.movimientos,
  };
  const umbrales = { historial: `≥ ${U.calentamiento + U.diasEvaluacionMin} días`, usos: `≥ ${U.usosMin} usos tras el calentamiento`, mejora_clara: `≥ ${U.mejoraMin * 100} % en un eje y no empeorar el otro más de ${U.margen * 100} %` };
  if (!suficiente || !actual.dias) return { muestra: actual.usos, suficiente: false, metricas, umbrales, hallazgos, detalle: { motivo: 'Historial corto: se dan las métricas de la configuración actual y no se propone nada.' } };
  // Fidelidad: la simulación pura y el Rotador real en sandbox deben coincidir con la configuración actual.
  const real = reproducirEnSandbox(historial, config, U.calentamiento);
  if (!igual(real, actual)) hallazgos.push({
    clave: 'simulacion-infiel', severidad: 'alta', titulo: 'La simulación del rotador no coincide con el rotador real',
    evidencia: `Con la configuración actual el Rotador en sandbox da ${real.fallos} fallos, ${real.instaladasMedia} instaladas de media y ${real.movimientos} movimientos; \`simularRotacion\` da ${actual.fallos}, ${actual.instaladasMedia} y ${actual.movimientos}.`,
    propuesta: 'Alinear `simularRotacion` con `plan`/`aplicar`/`asegurar` en `atlas/src/rotador.ts` (comparten `nivelPorDias`).',
  });
  const nucleos = [...new Set([...REJILLA.nucleo, config.nucleoDias])].sort((a, b) => a - b), frecuentes = [...new Set([...REJILLA.frecuente, config.frecuenteDias])].sort((a, b) => a - b);
  const rejilla = nucleos.flatMap((n) => frecuentes.filter((f) => f > n && n > config.instantaneaDias).map((f) => ({ nucleoDias: n, frecuenteDias: f, ...simularRotacion(historial, { ...config, nucleoDias: n, frecuenteDias: f }, U.calentamiento) })));
  const norma = (r: ResultadoSimulacion) => r.fallos / Math.max(1, actual.fallos) + r.instaladasMedia / Math.max(1, actual.instaladasMedia);
  const candidatas = rejilla.filter((g) => !(g.nucleoDias === config.nucleoDias && g.frecuenteDias === config.frecuenteDias) && mejoraClara(g, actual))
    .sort((a, b) => norma(a) - norma(b) || Math.abs(a.nucleoDias - config.nucleoDias) - Math.abs(b.nucleoDias - config.nucleoDias));
  const mejor = candidatas[0];
  if (mejor) hallazgos.push({
    clave: 'dias-rotador', severidad: 'media', titulo: `Con otros días el rotador habría fallado menos o dejado menos skills instaladas (núcleo ${mejor.nucleoDias}, frecuente ${mejor.frecuenteDias})`,
    evidencia: `Reproducido día a día sobre ${diasHistorial} días de historial (${actual.usos} usos puntuables):\n- actual (núcleo ${config.nucleoDias}, frecuente ${config.frecuenteDias}): ${actual.fallos} fallos (${tasa(actual)}), ${actual.instaladasMedia} instaladas de media, ${actual.movimientos} movimientos.\n- propuesta (núcleo ${mejor.nucleoDias}, frecuente ${mejor.frecuenteDias}): ${mejor.fallos} fallos (${tasa(mejor)}), ${mejor.instaladasMedia} instaladas de media, ${mejor.movimientos} movimientos.\nSolo \`frecuenteDias\` decide qué se retira: el núcleo es una etiqueta de nivel.`,
    propuesta: `Poner en la \`config\` de rotador.json \`nucleoDias: ${mejor.nucleoDias}\` y \`frecuenteDias: ${mejor.frecuenteDias}\` (con la cabecera \`x-karajan-tarea\` de esta tarea) y repetir \`kj lab run rotador\`.`,
    criterios: ['Los días quedan en rotador.json con instantánea < núcleo < frecuente.', 'Con ellos, `kj lab run rotador` ya no da «dias-rotador» y el contrato sigue limpio.'],
  });
  return {
    muestra: actual.usos, suficiente, hallazgos, metricas, umbrales,
    detalle: { actual: { nucleoDias: config.nucleoDias, frecuenteDias: config.frecuenteDias, ...actual }, rejilla, propuesta: mejor ?? null },
  };
}

export const laboratorioRotador: Laboratorio<ContextoRotador> = {
  escenarios: [
    { id: 'contrato', tipo: 'contrato', descripcion: 'Días coherentes, protegidas fuera del plan, nada instalado y en el almacén a la vez, plan idempotente (en casa ficticia)', ejecutar: (c) => contrato(c) },
    { id: 'historial', tipo: 'replay', descripcion: 'Reproduce el historial de usos día a día en un sandbox para ajustar los días de núcleo y frecuente', ejecutar: (c) => replay(c) },
  ],
};
