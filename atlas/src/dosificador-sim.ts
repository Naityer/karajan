import { CONFIG_BASE, estadoInicial, type ConfigDosificador, type EstadoDosificador, type Prioridad } from './dosificador-config';
import { DIA, HORA, MIN, claseDeTarea, decidir, registrarCoste, registrarLimite, type TareaEntrada } from './dosificador';

/**
 * Simulador por replay del dosificador: semanas sintéticas con uso personal con picos laborales, tareas con coste lognormal y un
 * sesgo por clase de ±50 % respecto al prior (el estimador tiene que aprender), todo con una semilla (mismo escenario ⇒ mismas
 * métricas). Alimenta al `decidir` REAL ciclo a ciclo y mide si las decisiones cumplen lo que se le pide al dosificador:
 *   semanas que acaban por encima del margen (objetivo 0), % de cuota sin usar al renovar (objetivo < 15 %),
 *   espera p95 de las tareas y oscilaciones de modo (normal ⇄ frenado).
 */
export interface EscenarioSim {
  semanas: number; semilla: number; cicloMin: number;
  /** Lo que llega cada semana, como fracción del presupuesto de los agentes (1,1 = un 10 % más de lo que cabe). */
  demanda: number;
  /** Uso personal por semana y agente: mediana en % del plan, dispersión lognormal. */
  personal: { medianaPct: Record<string, number>; sigma: number };
  /** Sesgo máximo del coste real frente al prior: el coste de una clase es prior × U[1 − s, 1 + s]. */
  sesgoClase: number;
  /** Dispersión lognormal del coste de cada tarea. */
  sigmaTarea: number;
  agentes: string[]; equipos: string[];
  /** Inicio de la simulación: un lunes 00:00 UTC. */
  inicio: number;
  /** Fracción de tareas ancladas a un agente concreto (el resto va en `auto`). */
  fracFijas: number;
  /** Para depurar: se llama tras cada decisión con el instante, el uso de cada agente y el resultado. */
  traza?: (t: number, uso: Record<string, number>, r: ReturnType<typeof decidir>, cola: number) => void;
}
export const ESCENARIO_BASE: EscenarioSim = {
  semanas: 8, semilla: 1, cicloMin: 15, demanda: 1.3, personal: { medianaPct: { claude: 10, codex: 5 }, sigma: 0.4 }, sesgoClase: 0.5, sigmaTarea: 0.35,
  agentes: ['claude', 'codex'], equipos: ['pc', 'servidor'], inicio: Date.UTC(2026, 0, 5), fracFijas: 0.3,
};

export interface MetricasSim {
  semanas: number; agenteSemanas: number;
  semanasPorEncima: number; semanasConLimite: number; limitesAlcanzados: number;
  sinUsarPct: number; sinUsarMaxPct: number; usoFinalMedioPct: number; usoFinalMaxPct: number;
  esperaP50Horas: number | null; esperaP95Horas: number | null;
  oscilaciones: number; oscilacionesPorSemana: number;
  tareasLlegadas: number; tareasLanzadas: number; pendientesAlFinal: number;
  porSemana: { semana: number; agente: string; usoFinalPct: number; limites: number }[];
}
export interface ResultadoSim { metricas: MetricasSim; estado: EstadoDosificador }

function rng(semilla: number) {
  let s = (semilla >>> 0) || 1;
  const u = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const n = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, u()))) * Math.cos(2 * Math.PI * u());
  const poisson = (l: number) => { let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= u(); } while (p > L && k < 50); return k - 1; };
  return { u, n, poisson };
}

const NIVELES = [[1, 0.2], [2, 0.3], [3, 0.3], [4, 0.15], [5, 0.05]] as const;
const DOMINIOS = ['programming', 'security', 'data', 'documents'];
const PRIORIDADES_SIM: [Prioridad, number][] = [['critica', 0.02], ['alta', 0.15], ['normal', 0.6], ['baja', 0.2], ['minima', 0.03]];
const percentil = (v: number[], p: number) => (v.length ? [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))]! : null);

/** Cuánto pesa cada hora (UTC) del uso personal: pico laboral entre semana, tarde-noche suave y madrugada casi nula. */
const pesoPersonal = (t: number) => {
  const d = new Date(t), h = d.getUTCHours(), dia = d.getUTCDay();
  const laboral = dia >= 1 && dia <= 5;
  if (h >= 9 && h < 18) return laboral ? 4 : 1;
  if (h >= 18 && h < 23) return laboral ? 1.2 : 1;
  return 0.1;
};

export function simular(cfg: ConfigDosificador = CONFIG_BASE, parcial: Partial<EscenarioSim> = {}): ResultadoSim {
  const esc: EscenarioSim = { ...ESCENARIO_BASE, ...parcial, personal: { ...ESCENARIO_BASE.personal, ...(parcial.personal ?? {}) } };
  const R = rng(esc.semilla);
  const ciclo = esc.cicloMin * MIN, ciclosSemana = Math.round((7 * DIA) / ciclo), total = esc.semanas * ciclosSemana;
  const agentes = esc.agentes.filter((a) => cfg.planes[a]);
  const sesgo = new Map<string, number>();
  const sesgoDe = (clase: string) => { let s = sesgo.get(clase); if (s === undefined) { s = 1 + esc.sesgoClase * (2 * R.u() - 1); sesgo.set(clase, s); } return s; };
  const priorNivel = (n: number) => cfg.estimador.prior[String(n)] ?? cfg.estimador.costeDefectoPct;

  // Llegadas: la demanda semanal esperada es `demanda` × el presupuesto de los agentes (límite − margen − reserva).
  const presupuestoAgente = Math.max(1, 100 - cfg.margenSeguridadPct - cfg.reserva.fijaPct);
  const costeMedio = NIVELES.reduce((s, [n, w]) => s + w * priorNivel(n), 0) * Math.exp((esc.sigmaTarea ** 2) / 2);
  const lambda = (esc.demanda * presupuestoAgente * agentes.length) / costeMedio / ciclosSemana;

  interface TareaSim extends TareaEntrada { costeReal: number; clase: string }
  const cola: TareaSim[] = [];
  interface Corriendo { t: TareaSim; agente: string; equipo: string; resta: number; porCiclo: number; costeTotal: number }
  let corriendo: Corriendo[] = [];
  let est: EstadoDosificador = estadoInicial();
  let id = 0;
  const esperas: number[] = [];
  const uso: Record<string, number> = {}, consumo: Record<string, { t: number; pct: number }[]> = {};
  const personalSemana: Record<string, number> = {};
  const limitesSemana: Record<string, number> = {};
  const metricas: MetricasSim = {
    semanas: esc.semanas, agenteSemanas: 0, semanasPorEncima: 0, semanasConLimite: 0, limitesAlcanzados: 0, sinUsarPct: 0, sinUsarMaxPct: 0, usoFinalMedioPct: 0, usoFinalMaxPct: 0,
    esperaP50Horas: null, esperaP95Horas: null, oscilaciones: 0, oscilacionesPorSemana: 0, tareasLlegadas: 0, tareasLanzadas: 0, pendientesAlFinal: 0, porSemana: [],
  };
  const limiteSem = (a: string) => Math.max(...cfg.planes[a]!.ventanas.map((v) => v.limitePct));
  const ses = (a: string) => cfg.planes[a]!.ventanas.slice().sort((x, y) => x.duracionMin - y.duracionMin)[0]!;
  const escalaSes = (a: string) => ses(a).escalaCoste ?? 1;
  const sortearPersonal = (a: string) => { personalSemana[a] = (esc.personal.medianaPct[a] ?? 5) * Math.exp(esc.personal.sigma * R.n()); };
  // Pesos de las horas de una semana, para repartir el uso personal.
  let sumaPesos = 0;
  for (let c = 0; c < ciclosSemana; c++) sumaPesos += pesoPersonal(esc.inicio + c * ciclo);
  for (const a of agentes) { uso[a] = 0; consumo[a] = []; limitesSemana[a] = 0; sortearPersonal(a); }
  const reinicioDe = (semana: number) => esc.inicio + (semana + 1) * 7 * DIA;

  const consumir = (a: string, t: number, pct: number): number => {
    const libre = Math.max(0, 100 - uso[a]!);
    const real = Math.min(pct, libre);
    uso[a]! += real;
    consumo[a]!.push({ t, pct: real });
    return real;
  };

  for (let c = 0; c < total; c++) {
    const t = esc.inicio + c * ciclo, semana = Math.floor(c / ciclosSemana);
    // Nueva semana: se cierra la anterior y el plan se renueva.
    if (c > 0 && c % ciclosSemana === 0) {
      for (const a of agentes) {
        const final = uso[a]!;
        metricas.porSemana.push({ semana: semana - 1, agente: a, usoFinalPct: Math.round(final * 100) / 100, limites: limitesSemana[a]! });
        metricas.agenteSemanas++;
        if (final > limiteSem(a) - cfg.margenSeguridadPct + 1e-9) metricas.semanasPorEncima++;
        if (limitesSemana[a]! > 0) metricas.semanasConLimite++;
        metricas.sinUsarPct += 100 - final; metricas.sinUsarMaxPct = Math.max(metricas.sinUsarMaxPct, 100 - final);
        metricas.usoFinalMedioPct += final; metricas.usoFinalMaxPct = Math.max(metricas.usoFinalMaxPct, final);
        uso[a] = 0; limitesSemana[a] = 0; sortearPersonal(a);
      }
    }
    // Uso personal de este ciclo.
    for (const a of agentes) consumir(a, t, personalSemana[a]! * (pesoPersonal(t) / sumaPesos) * Math.exp(0.5 * Math.max(-2, Math.min(2, R.n())) - 0.125));
    // Las tareas en marcha gastan su coste a lo largo de su duración.
    const terminadas: Corriendo[] = [];
    for (const k of corriendo) {
      const real = consumir(k.agente, t, k.porCiclo);
      if (real < k.porCiclo - 1e-9) {
        metricas.limitesAlcanzados++; limitesSemana[k.agente]!++;
        est = registrarLimite(est, cfg, k.agente, reinicioDe(semana), t, () => 0.5);
      }
      k.resta--;
      if (k.resta <= 0) terminadas.push(k);
    }
    for (const k of terminadas) est = registrarCoste(est, cfg, { tarea: k.t.id, agente: k.agente, clase: k.t.clase, costePct: k.costeTotal * (1 + 0.05 * R.n()) });
    corriendo = corriendo.filter((k) => !terminadas.includes(k));
    // Llegadas.
    for (let i = R.poisson(lambda * (0.6 + 0.8 * (pesoPersonal(t) > 1 ? 1 : 0.4))); i > 0; i--) {
      let r = R.u(), nivel = 3;
      for (const [n, w] of NIVELES) { if (r < w) { nivel = n; break; } r -= w; }
      r = R.u();
      let prioridad: Prioridad = 'normal';
      for (const [p, w] of PRIORIDADES_SIM) { if (r < w) { prioridad = p; break; } r -= w; }
      const dominio = DOMINIOS[Math.floor(R.u() * DOMINIOS.length)]!;
      const fijo = R.u() < esc.fracFijas ? agentes[Math.floor(R.u() * agentes.length)]! : 'auto';
      const t0: TareaSim = {
        id: `t${++id}`, prioridad, creada: t, programada: null, agente: fijo, clasificacion: { nivel_tarea: `level_${nivel}`, dominio, intencion: 'implement_feature' }, repo: `repo${Math.floor(R.u() * 3)}`,
        costeReal: 0, clase: '',
      };
      // El coste real depende de la clase a la que acabe yendo (agente): se fija al lanzar si es `auto`.
      cola.push(t0); metricas.tareasLlegadas++;
    }
    // Decisión.
    const entrada = {
      ahora: t,
      tareas: cola.filter((x) => x.programada === null || x.programada <= t),
      equipos: esc.equipos.map((e, i) => ({ id: e, disponible: true, enCurso: Object.fromEntries(agentes.map((a) => [a, corriendo.filter((k) => k.equipo === e && k.agente === a).length])), repos: [`repo${i}`] })),
      agentes: Object.fromEntries(agentes.map((a) => [a, { disponible: true, enCurso: corriendo.filter((k) => k.agente === a).length }])),
      uso: Object.fromEntries(agentes.map((a) => {
        const reciente = consumo[a]!.filter((x) => x.t > t - 5 * HORA);
        consumo[a] = reciente;
        const us = Math.min(100, reciente.reduce((s, x) => s + x.pct, 0) * escalaSes(a));
        return [a, { semanal: Math.min(100, uso[a]!), sesion: us, reinicio: new Date(reinicioDe(semana)).toISOString(), reinicioSesion: reciente.length ? new Date(reciente[0]!.t + 5 * HORA).toISOString() : null, plan: 'sim', fuente: 'sim' }];
      })),
      leido: new Date(t).toISOString(),
    };
    const r = decidir(entrada, cfg, est);
    est = r.estado;
    esc.traza?.(t, uso, r, cola.length);
    for (const d of r.decisiones) {
      const tarea = cola.find((x) => x.id === d.tarea);
      if (!tarea) continue;
      if (d.lanzarEn !== null && d.lanzarEn > t) { tarea.programada = d.lanzarEn; continue; }
      const enAgente = corriendo.filter((k) => k.agente === d.agente).length, enEquipo = corriendo.filter((k) => k.agente === d.agente && k.equipo === d.equipo).length;
      if (enAgente >= (cfg.concurrencia.porAgente[d.agente] ?? 1) || enEquipo >= cfg.concurrencia.porEquipo) continue;
      // Se lanza: el coste real sale ahora de la clase con el agente elegido.
      const clase = claseDeTarea(tarea, d.agente);
      const nivel = Number(clase.split('|')[0]);
      const coste = priorNivel(nivel) * sesgoDe(clase) * Math.exp(esc.sigmaTarea * Math.max(-2, Math.min(2, R.n())) - (esc.sigmaTarea ** 2) / 2);
      const ciclos = 1 + Math.floor(R.u() * 3);
      corriendo.push({ t: { ...tarea, clase, costeReal: coste }, agente: d.agente, equipo: d.equipo, resta: ciclos, porCiclo: coste / ciclos, costeTotal: coste });
      cola.splice(cola.indexOf(tarea), 1);
      esperas.push((t - tarea.creada) / HORA);
      metricas.tareasLanzadas++;
    }
  }
  // Cierre de la última semana.
  for (const a of agentes) {
    const final = uso[a]!;
    metricas.porSemana.push({ semana: esc.semanas - 1, agente: a, usoFinalPct: Math.round(final * 100) / 100, limites: limitesSemana[a]! });
    metricas.agenteSemanas++;
    if (final > limiteSem(a) - cfg.margenSeguridadPct + 1e-9) metricas.semanasPorEncima++;
    if (limitesSemana[a]! > 0) metricas.semanasConLimite++;
    metricas.sinUsarPct += 100 - final; metricas.sinUsarMaxPct = Math.max(metricas.sinUsarMaxPct, 100 - final);
    metricas.usoFinalMedioPct += final; metricas.usoFinalMaxPct = Math.max(metricas.usoFinalMaxPct, final);
  }
  const n = Math.max(1, metricas.agenteSemanas);
  metricas.sinUsarPct = Math.round((metricas.sinUsarPct / n) * 100) / 100;
  metricas.usoFinalMedioPct = Math.round((metricas.usoFinalMedioPct / n) * 100) / 100;
  metricas.sinUsarMaxPct = Math.round(metricas.sinUsarMaxPct * 100) / 100;
  metricas.usoFinalMaxPct = Math.round(metricas.usoFinalMaxPct * 100) / 100;
  metricas.esperaP50Horas = percentil(esperas, 0.5) === null ? null : Math.round(percentil(esperas, 0.5)! * 10) / 10;
  metricas.esperaP95Horas = percentil(esperas, 0.95) === null ? null : Math.round(percentil(esperas, 0.95)! * 10) / 10;
  metricas.oscilaciones = Object.values(est.modos).reduce((s, m) => s + m.cambios, 0);
  metricas.oscilacionesPorSemana = Math.round((metricas.oscilaciones / (esc.semanas * Math.max(1, agentes.length))) * 10) / 10;
  metricas.pendientesAlFinal = cola.length;
  return { metricas, estado: est };
}
