import { decidir, DIA, HORA, registrarLimite, type EntradaDosificador, type TareaEntrada } from '../dosificador';
import { normalizarConfig, estadoInicial, type ConfigDosificador } from '../dosificador-config';
import { cuotaDeUso, leerCuotaClaude, leerCuotaCodex, leerCuotaLimites, ventanaDe } from '../dosificador-cuota';
import { simular } from '../dosificador-sim';
import type { Hallazgo } from '../pasarela-borradores';
import { proporcion, wilson, type ContextoLab, type Laboratorio, type Resultado } from '../laboratorio';

/**
 * Laboratorio del dosificador. Separa dos preguntas:
 *   ¿hace bien su función?  (`contrato`: los parsers de cuota leen las variantes conocidas con fixtures sintéticas, la decisión es
 *                            determinista y no lanza nada en un agente con el circuito abierto)
 *   ¿dosifica bien?         (`replay`: semanas sintéticas con uso personal con picos laborales y costes lognormales; ¿acaban por
 *                            debajo del margen?, ¿cuánta cuota queda sin usar al renovar?, ¿cuánto espera una tarea?, ¿oscila el modo?)
 * Todo es sintético: no lee límites ni registros reales, y no escribe nada.
 */
export interface ContextoDosificador extends ContextoLab {
  /** La configuración viva del dosificador (`<datos>/dosificador.json` normalizada). */
  config(): ConfigDosificador;
}

/** Umbrales del `replay`: muestra mínima en agente-semanas, cuota sin usar tolerable y oscilaciones por semana y agente. */
export const UMBRALES_DOSIFICADOR = { muestraMinima: 24, sinUsarMaxPct: 15, oscilacionesPorSemana: 6, esperaP95MaxHoras: 24 * 14, semillas: [1, 2, 3], semanasPorSemilla: 4 };

const AHORA = Date.UTC(2026, 10, 4, 12, 0, 0);
const REINICIO = AHORA + 4 * DIA;

// ── contrato ────────────────────────────────────────────────────────────────────────────────────
interface Caso { nombre: string; ok: boolean; detalle: string }
const casos = (): Caso[] => {
  const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const vs = (c: ReturnType<typeof leerCuotaClaude>) => c.ventanas.map((v) => [v.nombre, v.usadoPct, v.reinicio]);
  const lista: Caso[] = [];
  const cuando = (nombre: string, real: unknown, esperado: unknown) => lista.push({ nombre, ok: igual(real, esperado), detalle: `${JSON.stringify(real)} ≠ ${JSON.stringify(esperado)}` });
  cuando('claude · statusline (segundos)', vs(leerCuotaClaude({ rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1_790_000_000 }, seven_day: { used_percentage: 41, resets_at: 1_790_500_000 } } })),
    [['sesion', 23.5, 1_790_000_000_000], ['semanal', 41, 1_790_500_000_000]]);
  cuando('claude · api/oauth/usage (ISO)', vs(leerCuotaClaude({ five_hour: { utilization: 12.5, resets_at: '2026-11-04T15:00:00Z' }, seven_day: { utilization: 61, resets_at: '2026-11-08T12:00:00Z' } })),
    [['sesion', 12.5, Date.UTC(2026, 10, 4, 15)], ['semanal', 61, REINICIO]]);
  cuando('claude · fracciones 0-1', leerCuotaClaude({ five_hour: { utilization: 0.25 }, seven_day: { utilization: 0.5 } }).ventanas.map((v) => v.usadoPct), [25, 50]);
  cuando('codex · ventana por duración, no por posición', vs(leerCuotaCodex({ rate_limits: { primary: { used_percent: 70, window_minutes: 10080, resets_at: 1_790_500_000 }, secondary: { used_percent: 5, window_minutes: 300, resets_at: 1_790_000_000 } } })),
    [['sesion', 5, 1_790_000_000_000], ['semanal', 70, 1_790_500_000_000]]);
  cuando('codex · camelCase (app-server) y milisegundos', vs(leerCuotaCodex({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_790_000_000_000 } } })), [['sesion', 12, 1_790_000_000_000]]);
  cuando('campo ausente → null', vs(leerCuotaClaude({ five_hour: { resets_at: 1_790_000_000, used_percentage: null } })), [['sesion', null, 1_790_000_000_000]]);
  cuando('basura → sin ventanas', [leerCuotaClaude(null), leerCuotaCodex('x'), leerCuotaClaude([1, 2])].map((c) => c.ventanas.length), [0, 0, 0]);
  const plan = leerCuotaLimites({ claude: { semanal: 40, sesion: 10, reinicio: '2026-11-08T12:00:00Z', plan: 'max', fuente: 'statusline' }, codex: { semanal: 25, sesion: null, reinicio: null }, leido: '2026-11-04T11:55:00Z' });
  cuando('limites-plan.json', [ventanaDe(plan['claude'], 'semanal')?.usadoPct, ventanaDe(plan['claude'], 'semanal')?.reinicio, plan['claude']?.plan, ventanaDe(plan['codex'], 'sesion')?.usadoPct], [40, REINICIO, 'max', null]);
  return lista;
};

const entradaFija = (): EntradaDosificador => {
  const tarea = (id: string, extra: Partial<TareaEntrada> = {}): TareaEntrada => ({ id, prioridad: 'normal', creada: AHORA - HORA, programada: null, agente: 'auto', clasificacion: { nivel_tarea: 'level_2_moderate', dominio: 'programming' }, ...extra });
  const uso = (s: number) => ({ semanal: s, sesion: 10, reinicio: new Date(REINICIO).toISOString(), reinicioSesion: new Date(AHORA + 3 * HORA).toISOString(), plan: 'sintetico', fuente: 'laboratorio' });
  return {
    ahora: AHORA, tareas: [tarea('a'), tarea('b', { prioridad: 'alta' }), tarea('c', { agente: 'claude' }), tarea('d', { agente: 'codex', prioridad: 'baja' })],
    equipos: [{ id: 'pc', disponible: true, enCurso: { claude: 0, codex: 0 }, repos: ['x'] }, { id: 'servidor', disponible: true, enCurso: { claude: 0, codex: 0 }, repos: [] }],
    agentes: { claude: { disponible: true, enCurso: 0 }, codex: { disponible: true, enCurso: 0 } }, uso: { claude: uso(30), codex: uso(30) }, leido: new Date(AHORA - 60_000).toISOString(),
  };
};

function contrato(ctx: ContextoDosificador): Resultado {
  const hallazgos: Hallazgo[] = [];
  const cfg = normalizarConfig(ctx.config());
  // 1. Fidelidad de los parsers con fixtures sintéticas.
  const lecturas = casos();
  const fallos = lecturas.filter((c) => !c.ok);
  if (fallos.length) hallazgos.push({
    clave: 'parser-infiel', severidad: 'alta', titulo: `${fallos.length} de ${lecturas.length} lecturas de cuota no dan lo esperado`,
    evidencia: fallos.map((f) => `${f.nombre}: ${f.detalle}`).join('\n'),
    propuesta: 'Corregir el parser en `atlas/src/dosificador-cuota.ts`: con una lectura mala el dosificador dosifica con un % que no es el real.',
  });
  // 2. Determinismo: el mismo estado y la misma entrada dan la misma decisión.
  const previo = estadoInicial();
  const d1 = JSON.stringify(decidir(entradaFija(), cfg, previo)), d2 = JSON.stringify(decidir(entradaFija(), cfg, previo));
  const determinista = d1 === d2 && JSON.stringify(previo) === JSON.stringify(estadoInicial());
  if (!determinista) hallazgos.push({
    clave: 'decision-no-determinista', severidad: 'alta', titulo: 'El dosificador no es determinista', evidencia: 'Dos llamadas con la misma entrada y el mismo estado dieron decisiones distintas, o `decidir` mutó el estado que recibió.',
    propuesta: 'Quitar de `decidir` (atlas/src/dosificador.ts) cualquier reloj, azar o mutación del estado previo.',
  });
  // 3. Con el circuito de un agente abierto no se lanza nada en él, ni con la cuota a cero ni con el modo simulación.
  let lanzadosConCircuitoAbierto = 0, comprobaciones = 0;
  for (const agente of Object.keys(cfg.planes)) {
    const abierto = registrarLimite(estadoInicial(), cfg, agente, AHORA + 2 * HORA, AHORA);
    for (const uso of [10, 50, 80]) for (const sim of [false, true]) {
      const e = entradaFija();
      e.agentes[agente] = { disponible: true, enCurso: 0 };
      for (const a of Object.keys(e.uso)) e.uso[a] = { ...(e.uso[a] as object), semanal: uso };
      const r = decidir(e, { ...cfg, modoSimulacion: sim }, abierto);
      comprobaciones++;
      lanzadosConCircuitoAbierto += r.decisiones.filter((d) => d.agente === agente).length;
    }
  }
  if (lanzadosConCircuitoAbierto) hallazgos.push({
    clave: 'lanza-con-circuito-abierto', severidad: 'alta', titulo: 'Se decide lanzar en un agente con el circuito abierto', evidencia: `${lanzadosConCircuitoAbierto} decisiones sobre ${comprobaciones} comprobaciones.`,
    propuesta: 'Revisar `circuitoAbierto` y su uso en `evaluar` (atlas/src/dosificador.ts): un agente que acaba de topar con su límite no se toca hasta `resets_at`.',
  });
  // 4. Sin dato de cuota no se lanza (fail-closed), salvo en modo simulación.
  const ciega = entradaFija(); ciega.uso = { claude: {}, codex: cuotaDeUso('codex', null, null) };
  const sinDato = decidir(ciega, { ...cfg, modoSimulacion: false }, estadoInicial()).decisiones.length;
  if (sinDato) hallazgos.push({
    clave: 'lanza-a-ciegas', severidad: 'alta', titulo: 'Se decide lanzar sin dato de cuota', evidencia: `${sinDato} decisiones con la cuota ausente y el modo simulación apagado.`,
    propuesta: 'Restaurar el fail-closed en `evaluar` (atlas/src/dosificador.ts): dato ausente o caduco ⇒ diferir.',
  });
  // 5. La configuración viva está en rango (normalizar no la cambia).
  const enRango = JSON.stringify(normalizarConfig(cfg)) === JSON.stringify(cfg);
  if (!enRango) hallazgos.push({
    clave: 'config-fuera-de-rango', severidad: 'media', titulo: 'La configuración del dosificador no es estable al normalizarla', evidencia: 'normalizarConfig(config) ≠ config.',
    propuesta: 'Revisar `dosificador.json`: un valor se recorta o se reemplaza al leerlo.',
  });
  const total = lecturas.length + 4;
  return {
    muestra: total, suficiente: true, hallazgos,
    metricas: {
      parsers_fieles: proporcion(lecturas.length - fallos.length, lecturas.length), determinista: determinista ? 1 : 0, circuito_respetado: lanzadosConCircuitoAbierto ? 0 : 1,
      fail_closed: sinDato ? 0 : 1, config_en_rango: enRango ? 1 : 0,
    },
    umbrales: { parsers_fieles: '= 1', determinista: '= 1', circuito_respetado: '= 1', fail_closed: '= 1', config_en_rango: '= 1' },
    detalle: { lecturas: lecturas.map((c) => ({ nombre: c.nombre, ok: c.ok })) },
  };
}

// ── replay ──────────────────────────────────────────────────────────────────────────────────────
function replay(ctx: ContextoDosificador): Resultado {
  const U = UMBRALES_DOSIFICADOR, cfg = normalizarConfig(ctx.config());
  const corridas = U.semillas.map((semilla) => simular(cfg, { semanas: U.semanasPorSemilla, semilla }).metricas);
  const n = corridas.reduce((s, m) => s + m.agenteSemanas, 0);
  const sum = (f: (m: (typeof corridas)[number]) => number) => corridas.reduce((s, m) => s + f(m), 0);
  const margen = cfg.margenSeguridadPct;
  const semanas = corridas.flatMap((m) => m.porSemana);
  const encima = semanas.filter((w) => w.usoFinalPct > 100 - margen + 1e-9).length;
  const sinUsarAlto = semanas.filter((w) => 100 - w.usoFinalPct >= U.sinUsarMaxPct).length;
  const sinUsar = sum((m) => m.sinUsarPct * m.agenteSemanas) / Math.max(1, n);
  const limites = sum((m) => m.limitesAlcanzados);
  const osc = sum((m) => m.oscilaciones) / Math.max(1, corridas.reduce((s, m) => s + m.semanas, 0) * Object.keys(cfg.planes).length);
  const esperaP95 = Math.max(...corridas.map((m) => m.esperaP95Horas ?? 0));
  const suficiente = n >= U.muestraMinima;
  const [encInf, encSup] = wilson(encima, n), [sinInf] = wilson(sinUsarAlto, n);
  const hallazgos: Hallazgo[] = [];
  if (suficiente && (encima > 0 || limites > 0)) hallazgos.push({
    clave: 'margen-superado', severidad: 'alta', titulo: `${encima} de ${n} semanas de agente acaban por encima del margen de seguridad (${margen} %)`,
    evidencia: `IC95 de la proporción [${encInf.toFixed(2)}, ${encSup.toFixed(2)}]; ${limites} veces se topó con el límite del plan. Simulación con la configuración viva, ${U.semillas.length} semillas × ${U.semanasPorSemilla} semanas × ${Object.keys(cfg.planes).length} agentes.`,
    propuesta: 'Subir `margenSeguridadPct`, `reserva.fijaPct` o `estimador.percentil` en `dosificador.json`, o bajar `pacing.maxRafagaPct`.',
  });
  if (suficiente && sinUsar > U.sinUsarMaxPct && sinInf > 0.5) hallazgos.push({
    clave: 'cuota-sin-usar', severidad: 'media', titulo: `Se deja sin usar el ${sinUsar.toFixed(1)} % del plan al renovar (objetivo < ${U.sinUsarMaxPct} %)`,
    evidencia: `${sinUsarAlto} de ${n} semanas de agente acaban con ≥ ${U.sinUsarMaxPct} % sin usar (IC95 inferior ${sinInf.toFixed(2)}).`,
    propuesta: 'Bajar `margenSeguridadPct` o `reserva.fijaPct`, o subir `pacing.maxRafagaPct` y `concurrencia.porAgente` en `dosificador.json`.',
  });
  if (suficiente && osc > U.oscilacionesPorSemana) hallazgos.push({
    clave: 'modo-oscila', severidad: 'baja', titulo: `El modo cambia ${osc.toFixed(1)} veces por semana y agente (máximo ${U.oscilacionesPorSemana})`,
    evidencia: 'Cambios normal ⇄ frenado en la simulación.', propuesta: 'Subir `pacing.histeresisCiclos` o `pacing.bandaMuertaPct` en `dosificador.json`.',
  });
  return {
    muestra: n, suficiente, hallazgos,
    metricas: {
      semanas_por_encima: proporcion(encima, n), sin_usar: Math.round((sinUsar / 100) * 1000) / 1000, uso_final_medio: Math.round((sum((m) => m.usoFinalMedioPct * m.agenteSemanas) / Math.max(1, n) / 100) * 1000) / 1000,
      limites_alcanzados: limites, espera_p95_h: esperaP95, oscilaciones_semana: Math.round(osc * 10) / 10, margen_ic_sup: Math.round(encSup * 1000) / 1000,
    },
    umbrales: {
      semanas_por_encima: '= 0', margen_ic_sup: `< ${wilson(0, Math.max(n, 1))[1].toFixed(2)}`, sin_usar: `< ${U.sinUsarMaxPct} %`, limites_alcanzados: '= 0',
      espera_p95_h: `≤ ${U.esperaP95MaxHoras}`, oscilaciones_semana: `≤ ${U.oscilacionesPorSemana}`, muestra: `≥ ${U.muestraMinima} agente-semanas`,
    },
    detalle: { por_semilla: corridas.map((m, i) => ({ semilla: U.semillas[i], sin_usar_pct: m.sinUsarPct, uso_final_max_pct: m.usoFinalMaxPct, espera_p95_h: m.esperaP95Horas, oscilaciones: m.oscilaciones, tareas_lanzadas: m.tareasLanzadas })) },
  };
}

export const laboratorioDosificador: Laboratorio<ContextoDosificador> = {
  escenarios: [
    { id: 'contrato', tipo: 'contrato', descripcion: 'Los parsers de cuota leen las variantes conocidas, la decisión es determinista y no lanza con el circuito abierto ni sin dato (fixtures sintéticas)', ejecutar: (c) => contrato(c) },
    { id: 'replay', tipo: 'replay', descripcion: 'Semanas sintéticas con uso personal y costes lognormales: ¿acaba por debajo del margen, deja poca cuota sin usar y modera la espera?', ejecutar: (c) => replay(c) },
  ],
};
