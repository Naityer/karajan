import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CONFIG_BASE, estadoInicial, guardarConfig, guardarEstado, leerConfig, leerEstado, normalizarConfig, normalizarEstado, type ConfigDosificador, type EstadoDosificador,
} from '../src/dosificador-config';
import { cuotaDeUso, estadoCuota, leerCuotaClaude, leerCuotaCodex, leerCuotaLimites, tiempoMs, ventanaDe } from '../src/dosificador-cuota';
import {
  DIA, HORA, MIN, agotamientoDe, backoffMin, burnDe, circuitoAbierto, claseDe, decidir, estimar, observarClase, pacing, proximoPermitido, registrarCoste, registrarLimite,
  tiempoPonderado, transicionModo, validarEntrada, zDe, type EntradaDosificador, type TareaEntrada,
} from '../src/dosificador';

// Miércoles 4 nov 2026 12:00 UTC; el reinicio semanal es el domingo 8 a las 12:00 (4 días y 0 h por delante: 57 % de la semana pasada).
const AHORA = Date.UTC(2026, 10, 4, 12, 0, 0);
const REINICIO = AHORA + 4 * DIA;

const uso = (semanal: number | null, sesion: number | null = 5, extra: Record<string, unknown> = {}) => ({
  semanal, sesion, reinicio: new Date(REINICIO).toISOString(), reinicioSesion: new Date(AHORA + 3 * HORA).toISOString(), plan: 'max', fuente: 'test', ...extra,
});
const tarea = (id: string, extra: Partial<TareaEntrada> = {}): TareaEntrada => ({
  id, prioridad: 'normal', creada: AHORA - HORA, programada: null, agente: 'auto', clasificacion: { nivel_tarea: 'level_2_moderate', dominio: 'programming' }, ...extra,
});
function entrada(extra: Partial<EntradaDosificador> = {}): EntradaDosificador {
  return {
    ahora: AHORA, tareas: [tarea('t1')],
    equipos: [{ id: 'pc', disponible: true, enCurso: { claude: 0, codex: 0 }, repos: [] }, { id: 'servidor', disponible: true, enCurso: { claude: 0, codex: 0 }, repos: [] }],
    agentes: { claude: { disponible: true, enCurso: 0 }, codex: { disponible: true, enCurso: 0 } },
    uso: { claude: uso(40), codex: uso(40) }, leido: new Date(AHORA - 60_000).toISOString(), ...extra,
  };
}
const cfgCon = (parcial: unknown): ConfigDosificador => normalizarConfig(parcial);

describe('sondas de cuota', () => {
  it('Claude · statusline: five_hour y seven_day con used_percentage y resets_at en segundos', () => {
    const c = leerCuotaClaude({ model: 'x', rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 1_790_000_000 }, seven_day: { used_percentage: 41, resets_at: 1_790_500_000 } } }, AHORA);
    assert.equal(c.agente, 'claude');
    assert.deepEqual(c.ventanas.map((v) => [v.nombre, v.usadoPct, v.reinicio]), [['sesion', 23.5, 1_790_000_000_000], ['semanal', 41, 1_790_500_000_000]]);
    assert.equal(c.leido, AHORA);
  });
  it('Claude · api/oauth/usage: utilization con fechas ISO, y las ventanas nulas se ignoran', () => {
    const c = leerCuotaClaude({ five_hour: { utilization: 12.5, resets_at: '2026-11-04T15:00:00Z' }, seven_day: { utilization: 61, resets_at: '2026-11-08T10:00:00.5Z' }, seven_day_opus: null });
    assert.deepEqual(c.ventanas.map((v) => [v.nombre, v.usadoPct]), [['sesion', 12.5], ['semanal', 61]]);
    assert.equal(ventanaDe(c, 'sesion')!.reinicio, Date.parse('2026-11-04T15:00:00Z'));
  });
  it('acepta fracciones 0-1 (lado seguro: se sobrestima) y distingue las claves que dicen «percent»', () => {
    const f = leerCuotaClaude({ five_hour: { utilization: 0.25 }, seven_day: { utilization: 0.5 } });
    assert.deepEqual(f.ventanas.map((v) => v.usadoPct), [25, 50]);
    const p = leerCuotaCodex({ rate_limits: { primary: { used_percent: 0.5, window_minutes: 300 }, secondary: { used_percent: 0.25, window_minutes: 10080 } } });
    assert.deepEqual(p.ventanas.map((v) => v.usadoPct), [0.5, 0.25], 'used_percent siempre es un porcentaje');
    const e = leerCuotaClaude({ five_hour: { used_fraction: 0.4 } });
    assert.equal(e.ventanas[0]!.usadoPct, 40);
  });
  it('Codex · la ventana se reconoce por window_minutes, no por primary/secondary', () => {
    const normal = leerCuotaCodex({ rate_limits: { primary: { used_percent: 10, window_minutes: 300, resets_at: 1_790_000_000 }, secondary: { used_percent: 55, window_minutes: 10080, resets_at: 1_790_500_000 } } });
    assert.deepEqual(normal.ventanas.map((v) => [v.nombre, v.usadoPct]), [['sesion', 10], ['semanal', 55]]);
    const gratis = leerCuotaCodex({ rate_limits: { primary: { used_percent: 80, window_minutes: 10080, resets_at: 1_790_500_000_000 }, secondary: null } });
    assert.deepEqual(gratis.ventanas.map((v) => [v.nombre, v.usadoPct, v.reinicio]), [['semanal', 80, 1_790_500_000_000]], 'primary de 7 días es la semanal; resets_at en ms');
    const invertido = leerCuotaCodex({ rate_limits: { primary: { used_percent: 70, window_minutes: 10080 }, secondary: { used_percent: 5, window_minutes: 300 } } });
    assert.deepEqual(invertido.ventanas.map((v) => [v.nombre, v.usadoPct]), [['sesion', 5], ['semanal', 70]]);
  });
  it('Codex · camelCase del app-server y evento de rollout con la cuota anidada', () => {
    const app = leerCuotaCodex({ rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_790_000_000 }, secondary: { usedPercent: 33, windowDurationMins: 10080, resetsAt: 1_790_500_000 } }, planType: 'plus' });
    assert.deepEqual(app.ventanas.map((v) => [v.nombre, v.usadoPct, v.minutos]), [['sesion', 12, 300], ['semanal', 33, 10080]]);
    assert.equal(app.plan, 'plus');
    const rollout = leerCuotaCodex({ timestamp: 'x', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5 } }, rate_limits: { primary: { used_percent: 7, window_minutes: 300, resets_in_seconds: 600 }, secondary: { used_percent: 9, window_minutes: 10080, resets_in_seconds: 86_400 } } } }, AHORA);
    assert.deepEqual(rollout.ventanas.map((v) => [v.nombre, v.usadoPct, v.reinicio]), [['sesion', 7, AHORA + 600_000], ['semanal', 9, AHORA + DIA * 1000 / 1000]]);
  });
  it('campos ausentes son null y la basura no lanza', () => {
    const c = leerCuotaClaude({ rate_limits: { five_hour: { resets_at: 1_790_000_000, used_percentage: null }, seven_day: { used_percentage: 'no' } } });
    assert.deepEqual(c.ventanas.map((v) => [v.nombre, v.usadoPct]), [['sesion', null]]);
    for (const basura of [null, undefined, 42, 'texto', [], [1, 2], { rate_limits: 5 }, { a: { b: { c: {} } } }, { five_hour: { used_percentage: -3 } }, { five_hour: { used_percentage: 250 } }]) {
      assert.doesNotThrow(() => leerCuotaClaude(basura));
      assert.doesNotThrow(() => leerCuotaCodex(basura));
    }
    assert.equal(leerCuotaClaude({ five_hour: { used_percentage: 250 } }).ventanas[0]!.usadoPct, 100, 'se recorta a 100');
    assert.equal(leerCuotaClaude({ five_hour: { used_percentage: -3 } }).ventanas[0]!.usadoPct, null);
    assert.deepEqual(leerCuotaClaude(null).ventanas, []);
  });
  it('tiempoMs: segundos, milisegundos, ISO y basura', () => {
    assert.equal(tiempoMs(1_790_000_000), 1_790_000_000_000);
    assert.equal(tiempoMs(1_790_000_000_123), 1_790_000_000_123);
    assert.equal(tiempoMs('1790000000'), 1_790_000_000_000);
    assert.equal(tiempoMs('2026-11-08T12:00:00Z'), REINICIO);
    for (const x of [null, undefined, 0, -5, 'ayer', {}, NaN]) assert.equal(tiempoMs(x), null);
  });
  it('limites-plan.json de Atlas dev: Claude y Codex con reinicio, plan y fuente', () => {
    const q = leerCuotaLimites({
      claude: { semanal: 40, sesion: 10, reinicio: '2026-11-08T12:00:00Z', reinicioSesion: '2026-11-04T15:00:00Z', plan: 'max', fuente: 'statusline' },
      codex: { semanal: 25, sesion: null, reinicio: '2026-11-07T00:00:00Z', plan: 'plus', fuente: 'rollouts' }, leido: '2026-11-04T11:55:00Z',
    });
    assert.equal(q['claude']!.plan, 'max');
    assert.equal(q['claude']!.leido, Date.parse('2026-11-04T11:55:00Z'));
    assert.equal(ventanaDe(q['claude'], 'semanal')!.reinicio, REINICIO);
    assert.equal(ventanaDe(q['codex'], 'sesion')!.usadoPct, null);
    assert.equal(q['codex']!.fuente, 'rollouts');
    assert.deepEqual(leerCuotaLimites(null)['claude']!.ventanas.map((v) => v.usadoPct), [null, null]);
  });
  it('estadoCuota: ok, caduca (leída hace demasiado) y ausente (ni un porcentaje)', () => {
    const ok = cuotaDeUso('claude', uso(40), AHORA - 5 * MIN);
    assert.equal(estadoCuota(ok, AHORA, 120), 'ok');
    assert.equal(estadoCuota(cuotaDeUso('claude', uso(40), AHORA - 3 * HORA), AHORA, 120), 'caduca');
    assert.equal(estadoCuota(cuotaDeUso('claude', uso(40), AHORA + HORA), AHORA, 120), 'caduca', 'una lectura del futuro tampoco se cree');
    assert.equal(estadoCuota(cuotaDeUso('claude', uso(null, null), AHORA), AHORA, 120), 'ausente');
    assert.equal(estadoCuota(null, AHORA, 120), 'ausente');
    assert.equal(estadoCuota(cuotaDeUso('claude', uso(40), null), AHORA, 120), 'ok', 'sin hora de lectura la fiabilidad la pone el host');
  });
});

describe('configuración', () => {
  it('normalizarConfig nunca lanza: lo desconocido vuelve a los valores por defecto y los números se recortan', () => {
    for (const crudo of [null, undefined, 7, 'x', [], { planes: 5 }, { planes: { claude: 'x' } }, { pacing: { kp: 'mucho', modo: 'raro' } }, { horario: { zona: 3, silencio: 'noche' } }, { margenSeguridadPct: Number.NaN }]) {
      const c = normalizarConfig(crudo);
      assert.equal(c.pacing.modo === 'asap' || c.pacing.modo === 'lineal_p', true);
      assert.ok(c.planes['claude']!.ventanas.length >= 1);
    }
    assert.deepEqual(normalizarConfig(null), CONFIG_BASE);
    const c = normalizarConfig({ margenSeguridadPct: 500, margen5hPct: -4, pacing: { kp: 99, retrasoMaxMin: -1, histeresisCiclos: 0 }, reserva: { modo: 'perfil', percentil: 7 }, estimador: { percentil: 0.1 }, modoSimulacion: 'si' });
    assert.equal(c.margenSeguridadPct, 50);
    assert.equal(c.margen5hPct, 0);
    assert.deepEqual([c.pacing.kp, c.pacing.retrasoMaxMin, c.pacing.histeresisCiclos], [20, 0, 1]);
    assert.equal(c.reserva.modo, 'perfil');
    assert.equal(c.reserva.percentil, 0.99);
    assert.equal(c.estimador.percentil, 0.5);
    assert.equal(c.modoSimulacion, false);
  });
  it('un plan nuevo se añade y los de Claude y Codex siempre existen; las ventanas se validan', () => {
    const c = normalizarConfig({ planes: { gemini: { ventanas: [{ nombre: 'dia', duracionMin: 1440, tipo: 'rodante', limitePct: 100 }, { nombre: 'mal nombre!!', duracionMin: -5 }] } } });
    assert.deepEqual(Object.keys(c.planes).sort(), ['claude', 'codex', 'gemini']);
    assert.equal(c.concurrencia.porAgente['gemini'], 1);
    assert.equal(c.planes['gemini']!.ventanas[0]!.duracionMin, 1440);
    assert.ok(c.planes['gemini']!.ventanas.every((v) => v.duracionMin >= 1 && /^[\w.-]+$/.test(v.nombre)));
  });
  it('se guarda en <datos>/dosificador.json mezclando con lo guardado, y un fichero ilegible vuelve a la base', () => {
    const d = mkdtempSync(join(tmpdir(), 'dosif-'));
    try {
      const ruta = join(d, 'dosificador.json');
      assert.deepEqual(leerConfig(ruta), CONFIG_BASE);
      guardarConfig(ruta, { margenSeguridadPct: 15, pacing: { kp: 2 } });
      guardarConfig(ruta, { pacing: { bandaMuertaPct: 5 } });
      const c = leerConfig(ruta);
      assert.deepEqual([c.margenSeguridadPct, c.pacing.kp, c.pacing.bandaMuertaPct, c.pacing.retrasoMaxMin], [15, 2, 5, CONFIG_BASE.pacing.retrasoMaxMin]);
      assert.equal(JSON.parse(readFileSync(ruta, 'utf8')).margenSeguridadPct, 15);
      guardarConfig(ruta, { margenSeguridadPct: 'basura' });
      assert.equal(leerConfig(ruta).margenSeguridadPct, CONFIG_BASE.margenSeguridadPct, 'un valor inválido no se guarda');
      // estado: ida y vuelta y tolerancia
      const r = join(d, 'dosificador-estado.json');
      assert.deepEqual(leerEstado(r), estadoInicial());
      const e = decidir(entrada(), CONFIG_BASE, null).estado;
      guardarEstado(r, e);
      assert.deepEqual(leerEstado(r), normalizarEstado(e));
      assert.deepEqual(normalizarEstado({ estimador: 7, leases: { x: { agente: 3 } }, muestras: { claude: 'no' } }), estadoInicial());
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

describe('estimador', () => {
  it('con una clase sin historia usa el prior del nivel; p80 = media + 0,84·σ', () => {
    assert.ok(Math.abs(zDe(0.8) - 0.8416) < 0.002);
    assert.ok(Math.abs(zDe(0.5)) < 1e-6);
    assert.ok(Math.abs(zDe(0.99) - 2.326) < 0.005);
    const e = estimar(estadoInicial(), CONFIG_BASE, claseDe(3, 'programming', 'claude'));
    assert.equal(e.fuente, 'prior');
    assert.equal(e.media, CONFIG_BASE.estimador.prior['3']);
    assert.ok(Math.abs(e.p - (e.media + zDe(0.8) * e.sigma)) < 1e-9);
    assert.ok(e.p > e.media && e.pGuarda > e.p);
  });
  it('aprende: la media converge al coste real, la varianza refleja la dispersión y el p80 queda por encima de la media', () => {
    const clase = claseDe(2, 'data', 'codex');
    let est = estadoInicial();
    const costes = [1.0, 1.4, 0.8, 1.2, 1.0, 1.6, 0.9, 1.1, 1.3, 1.0, 1.2, 0.9];
    for (const c of costes) est = observarClase(est, CONFIG_BASE, clase, c);
    assert.equal(est.estimador[clase]!.n, costes.length);
    const e = estimar(est, CONFIG_BASE, clase);
    assert.equal(e.fuente, 'observado');
    assert.ok(Math.abs(e.media - 1.1) < 0.2, `media ${e.media}`);
    assert.ok(e.p > e.media && e.p < 2.5);
    assert.ok(est.estimador['*|codex'], 'la calibración del agente se anota aparte');
  });
  it('con poca muestra mezcla con el prior y entradas inválidas no lo corrompen', () => {
    const clase = claseDe(3, 'x', 'claude');
    let est = observarClase(estadoInicial(), CONFIG_BASE, clase, 6);
    assert.equal(estimar(est, CONFIG_BASE, clase).fuente, 'mezcla');
    for (const mal of [Number.NaN, -1, Infinity, 1e9]) est = observarClase(est, CONFIG_BASE, clase, mal);
    assert.equal(est.estimador[clase]!.n, 1);
    const a = estimar(est, CONFIG_BASE, clase).media;
    assert.ok(a > CONFIG_BASE.estimador.prior['3']! && a < 6, 'entre el prior y lo observado');
  });
  it('registrarCoste libera el lease y suma el gasto de los agentes', () => {
    const r = decidir(entrada(), CONFIG_BASE, null);
    assert.equal(Object.keys(r.estado.leases).length, 1);
    const e = registrarCoste(r.estado, CONFIG_BASE, { tarea: 't1', agente: r.decisiones[0]!.agente, clase: claseDe(2, 'programming', r.decisiones[0]!.agente), costePct: 0.9 });
    assert.deepEqual(Object.keys(e.leases), []);
    assert.equal(e.gasto[r.decisiones[0]!.agente], 0.9);
    assert.equal(Object.keys(r.estado.leases).length, 1, 'el estado de entrada no se muta');
  });
});

describe('pacer', () => {
  it('techo = límite − margen − reserva; presupuesto = techo − uso − comprometido', () => {
    const p = pacing(CONFIG_BASE, CONFIG_BASE.planes['claude']!.ventanas[1]!, { usadoPct: 30, reinicio: REINICIO, ahora: AHORA, reservaPct: 12, comprometidoPct: 3 });
    assert.equal(p.techoPct, 100 - 10 - 12);
    assert.equal(p.presupuestoPct, 78 - 30 - 3);
    assert.ok(Math.abs(p.fraccion! - 3 / 7) < 1e-9);
    assert.ok(Math.abs(p.lineaPct! - 90 * (3 / 7)) < 1e-9);
    assert.ok(Math.abs(p.errorPct! - (30 - 90 * (3 / 7))) < 1e-9);
  });
  it('por debajo de la línea no hay retraso; por encima, kp·error/tasa acotado por el máximo', () => {
    const v = CONFIG_BASE.planes['claude']!.ventanas[1]!;
    assert.equal(pacing(CONFIG_BASE, v, { usadoPct: 10, reinicio: REINICIO, ahora: AHORA, reservaPct: 0 }).retrasoMin, 0);
    const p = pacing(CONFIG_BASE, v, { usadoPct: 50, reinicio: REINICIO, ahora: AHORA, reservaPct: 0 });
    const tasa = 90 / 168;
    assert.ok(Math.abs(p.retrasoMin - ((50 - 90 * 3 / 7) / tasa) * 60) < 1e-6 || p.retrasoMin === CONFIG_BASE.pacing.retrasoMaxMin);
    const mucho = pacing(cfgCon({ pacing: { retrasoMaxMin: 30 } }), v, { usadoPct: 85, reinicio: REINICIO, ahora: AHORA, reservaPct: 0 });
    assert.equal(mucho.retrasoMin, 30);
    assert.equal(pacing(cfgCon({ pacing: { modo: 'asap' } }), v, { usadoPct: 85, reinicio: REINICIO, ahora: AHORA, reservaPct: 0 }).retrasoMin, 0);
  });
  it('propiedad: más margen de seguridad ⇒ techo menor y retraso mayor o igual', () => {
    const v = CONFIG_BASE.planes['claude']!.ventanas[1]!;
    for (const U of [5, 20, 40, 55, 70, 85]) for (const frac of [0.1, 0.4, 0.7, 0.95]) {
      let anterior: { retraso: number; techo: number } | null = null;
      for (const margen of [0, 5, 10, 20, 30]) {
        const p = pacing(cfgCon({ margenSeguridadPct: margen, pacing: { retrasoMaxMin: 10_080 } }), v, { usadoPct: U, reinicio: AHORA + (1 - frac) * 7 * DIA, ahora: AHORA, reservaPct: 5 });
        if (anterior) { assert.ok(p.retrasoMin >= anterior.retraso - 1e-9, `U=${U} f=${frac} m=${margen}`); assert.ok(p.techoPct <= anterior.techo + 1e-9); }
        anterior = { retraso: p.retrasoMin, techo: p.techoPct };
      }
    }
  });
  it('sin fecha de reinicio no hay línea ni retraso: estado seguro (frenado) y el presupuesto sigue acotado', () => {
    const p = pacing(CONFIG_BASE, CONFIG_BASE.planes['claude']!.ventanas[1]!, { usadoPct: 30, reinicio: null, ahora: AHORA, reservaPct: 0 });
    assert.equal(p.sinFecha, true);
    assert.equal(p.lineaPct, null);
    assert.equal(p.presupuestoPct, 60);
    const r = decidir(entrada({ uso: { claude: uso(30, 5, { reinicio: null }), codex: uso(30, 5, { reinicio: null }) } }), CONFIG_BASE, null);
    assert.equal(r.resumen.modo, 'frenado');
    assert.ok(r.agentes['claude']!.sinFecha);
  });
  it('histéresis: hacen falta N ciclos fuera de la banda para cambiar; bloqueado manda al instante', () => {
    const o = { bloqueado: false, error: 5, banda: 3, ciclos: 3 };
    let s = { modo: 'normal' as const, pendiente: 0 } as ReturnType<typeof transicionModo>;
    s = transicionModo(s.modo, s.pendiente, o); assert.deepEqual(s, { modo: 'normal', pendiente: 1 });
    s = transicionModo(s.modo, s.pendiente, o); assert.deepEqual(s, { modo: 'normal', pendiente: 2 });
    s = transicionModo(s.modo, s.pendiente, o); assert.deepEqual(s, { modo: 'frenado', pendiente: 0 });
    s = transicionModo(s.modo, s.pendiente, { ...o, error: 1 }); assert.equal(s.modo, 'frenado', 'dentro de la banda pero aún por delante de la línea: sigue frenado');
    for (let i = 0; i < 3; i++) s = transicionModo(s.modo, s.pendiente, { ...o, error: -2 });
    assert.equal(s.modo, 'normal');
    assert.deepEqual(transicionModo('normal', 0, { ...o, bloqueado: true }), { modo: 'bloqueado', pendiente: 0 });
    assert.equal(transicionModo('bloqueado', 0, { ...o, error: -1 }).modo, 'normal');
    assert.equal(transicionModo('normal', 0, { ...o, error: null }).modo, 'frenado');
  });
  it('horario: horas útiles ponderadas, silencio que cruza la medianoche y próximo instante permitido', () => {
    const h = { zona: 'UTC', silencio: { desde: 22, hasta: 6 }, trabajo: null };
    assert.equal(tiempoPonderado(h, Date.UTC(2026, 10, 4), Date.UTC(2026, 10, 5)), 16);
    assert.equal(tiempoPonderado({ ...h, silencio: null }, 0, 3 * HORA), 3);
    assert.equal(proximoPermitido(h, Date.UTC(2026, 10, 4, 23, 30)), Date.UTC(2026, 10, 5, 6, 0));
    assert.equal(proximoPermitido(h, AHORA), AHORA);
    const t = { zona: 'UTC', silencio: null, trabajo: { dias: [3], desde: 9, hasta: 18, peso: 0.5 } };
    assert.equal(tiempoPonderado(t, Date.UTC(2026, 10, 4, 0), Date.UTC(2026, 10, 5, 0)), 15 + 9 * 0.5);
  });
  it('burn rate y agotamiento proyectado', () => {
    const m = [{ t: AHORA - 10 * HORA, u: 20 }, { t: AHORA - 5 * HORA, u: 25 }, { t: AHORA, u: 30 }];
    assert.equal(burnDe(m, AHORA), 1);
    assert.equal(burnDe([m[2]!], AHORA), null);
    assert.equal(burnDe([...m, { t: AHORA + 1, u: 1 }].slice(0, 3), AHORA), 1);
    assert.equal(burnDe([{ t: AHORA - 10 * HORA, u: 90 }, { t: AHORA - 5 * HORA, u: 5 }, { t: AHORA, u: 10 }], AHORA), 1, 'tras un reinicio solo cuenta el último tramo');
    assert.equal(agotamientoDe(30, 1, 100, null, AHORA), new Date(AHORA + 70 * HORA).toISOString());
    assert.equal(agotamientoDe(30, 1, 100, AHORA + 10 * HORA, AHORA), null, 'si llega al reinicio antes de agotarse, no hay agotamiento');
    assert.equal(agotamientoDe(30, 0, 100, null, AHORA), null);
  });
});

describe('decidir', () => {
  it('reparte las tareas auto entre los dos agentes, a lo sumo una decisión por agente y equipo, y lo devuelve en el formato del contrato', () => {
    const r = decidir(entrada({ tareas: [tarea('a'), tarea('b'), tarea('c')] }), CONFIG_BASE, null);
    assert.equal(r.decisiones.length, 2);
    assert.deepEqual(new Set(r.decisiones.map((d) => d.agente)), new Set(['claude', 'codex']));
    assert.equal(new Set(r.decisiones.map((d) => `${d.agente}|${d.equipo}`)).size, r.decisiones.length);
    for (const d of r.decisiones) assert.deepEqual(Object.keys(d).sort(), ['agente', 'equipo', 'lanzarEn', 'motivo', 'tarea']);
    assert.ok(r.diferidas.every((d) => d.tarea === 'c'), 'la tercera ni se decide ni se pierde: o sale diferida o se queda en cola');
    assert.deepEqual(Object.keys(r.resumen).sort(), ['agotamiento', 'burn', 'circuitos', 'modo']);
    assert.deepEqual(r.resumen.circuitos, { claude: false, codex: false });
    assert.equal(r.resumen.modo, 'normal');
  });
  it('propiedad: el mismo estado produce la misma decisión (y no muta lo que recibe)', () => {
    const e = entrada({ tareas: [tarea('a', { prioridad: 'alta' }), tarea('b'), tarea('c', { agente: 'codex' })] });
    const previo = decidir(entrada(), CONFIG_BASE, null).estado;
    const copia = JSON.stringify(previo);
    const r1 = decidir(e, CONFIG_BASE, previo), r2 = decidir(e, CONFIG_BASE, previo);
    assert.deepEqual(r1, r2);
    assert.equal(JSON.stringify(previo), copia);
    assert.deepEqual(decidir(e, CONFIG_BASE, null), decidir(e, CONFIG_BASE, null));
  });
  it('una tarea fijada a un agente solo se decide para ese agente', () => {
    const r = decidir(entrada({ tareas: [tarea('a', { agente: 'codex' }), tarea('b', { agente: 'codex' })] }), CONFIG_BASE, null);
    assert.deepEqual(r.decisiones.map((d) => d.agente), ['codex']);
    assert.equal(r.diferidas.length, 1);
    assert.match(r.diferidas[0]!.motivo, /^codex:/);
  });
  it('circuito abierto ⇒ nunca lanza en ese agente (propiedad sobre muchos estados), y se cierra en resets_at', () => {
    const resets = AHORA + 3 * HORA;
    let est = registrarLimite(estadoInicial(), CONFIG_BASE, 'claude', resets, AHORA);
    assert.equal(circuitoAbierto(est, 'claude', AHORA), resets);
    assert.equal(circuitoAbierto(est, 'claude', resets - 1), resets);
    assert.equal(circuitoAbierto(est, 'claude', resets), null, 'cierra EN resets_at');
    let semilla = 7;
    const azar = () => { semilla = (semilla * 48271) % 2147483647; return semilla / 2147483647; };
    for (let i = 0; i < 200; i++) {
      const tareas = Array.from({ length: 1 + Math.floor(azar() * 5) }, (_, k) => tarea(`t${k}`, { agente: azar() < 0.3 ? 'claude' : 'auto', prioridad: (['critica', 'alta', 'normal', 'baja', 'minima'] as const)[Math.floor(azar() * 5)]! }));
      const e = entrada({ tareas, uso: { claude: uso(Math.floor(azar() * 100)), codex: uso(Math.floor(azar() * 100)) } });
      const r = decidir(e, azar() < 0.5 ? CONFIG_BASE : cfgCon({ modoSimulacion: true, pacing: { modo: 'asap' } }), est);
      assert.ok(r.decisiones.every((d) => d.agente !== 'claude'), 'con el circuito de Claude abierto no se decide nada para Claude');
      assert.equal(r.resumen.circuitos['claude'], true);
    }
    const fijada = decidir(entrada({ tareas: [tarea('a', { agente: 'claude' })] }), CONFIG_BASE, est);
    assert.deepEqual(fijada.diferidas, [{ tarea: 'a', hasta: resets, motivo: `claude: circuito abierto (límite alcanzado) hasta ${new Date(resets).toISOString()}` }]);
    const despues = decidir(entrada({ ahora: resets + MIN, tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(20), codex: uso(20) }, leido: new Date(resets).toISOString() }), CONFIG_BASE, est);
    assert.equal(despues.decisiones[0]?.agente, 'claude');
    assert.equal(despues.resumen.circuitos['claude'], false);
    est = despues.estado;
    assert.equal(est.circuitos['claude']!.abiertoHasta, null);
  });
  it('el circuito abre tras N límites y, si el proveedor no dice cuándo se renueva, usa backoff con jitter acotado', () => {
    const cfg = cfgCon({ circuito: { umbralLimites: 2 }, reintento: { baseMin: 10, maxMin: 100, jitter: 0 } });
    let est = registrarLimite(estadoInicial(), cfg, 'codex', AHORA + HORA, AHORA);
    assert.equal(circuitoAbierto(est, 'codex', AHORA), null, 'un límite no basta con umbral 2');
    est = registrarLimite(est, cfg, 'codex', AHORA + HORA, AHORA + MIN);
    assert.equal(circuitoAbierto(est, 'codex', AHORA + MIN), AHORA + HORA);
    const sinFecha = registrarLimite(estadoInicial(), CONFIG_BASE, 'codex', null, AHORA, () => 0.5);
    assert.equal(circuitoAbierto(sinFecha, 'codex', AHORA), AHORA + CONFIG_BASE.reintento.baseMin * MIN, 'sin resets_at: backoff, no «para siempre»');
    const pasado = registrarLimite(estadoInicial(), CONFIG_BASE, 'codex', AHORA - HORA, AHORA, () => 0.5);
    assert.ok(circuitoAbierto(pasado, 'codex', AHORA)! > AHORA);
  });
  it('backoffMin: exponencial, con tope y jitter dentro de ±jitter (rand inyectado)', () => {
    const c = cfgCon({ reintento: { baseMin: 5, maxMin: 60, jitter: 0.2 } });
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffMin(n, c, () => 0.5)), [5, 10, 20, 40, 60, 60]);
    assert.equal(backoffMin(1, c, () => 0), 4);
    assert.equal(backoffMin(1, c, () => 1), 6);
    assert.ok(backoffMin(50, c, () => 0.9) <= 60);
  });
  it('dato de cuota ausente o caduco ⇒ no lanza (fail-closed); con modoSimulacion sí', () => {
    const sinDato = entrada({ uso: { claude: uso(null, null), codex: {} } });
    const r = decidir(sinDato, CONFIG_BASE, null);
    assert.deepEqual(r.decisiones, []);
    assert.equal(r.diferidas.length, 1);
    assert.match(r.diferidas[0]!.motivo, /sin dato de cuota/);
    const viejo = decidir(entrada({ leido: new Date(AHORA - 5 * HORA).toISOString() }), CONFIG_BASE, null);
    assert.deepEqual(viejo.decisiones, []);
    assert.match(viejo.diferidas[0]!.motivo, /caduco/);
    const reiniciada = decidir(entrada({ uso: { claude: uso(40, 5, { reinicio: new Date(AHORA - HORA).toISOString() }), codex: uso(40, 5, { reinicio: new Date(AHORA - HORA).toISOString() }) } }), CONFIG_BASE, null);
    assert.deepEqual(reiniciada.decisiones, [], 'si el reinicio ya pasó, la lectura es de la ventana anterior');
    const sim = decidir(sinDato, cfgCon({ modoSimulacion: true }), null);
    assert.ok(sim.decisiones.length >= 1);
    for (const raro of [{}, { uso: {} }, { agentes: {} }, { equipos: [] }, { tareas: [] }]) assert.doesNotThrow(() => decidir(entrada(raro), CONFIG_BASE, null));
  });
  it('bloqueo total hasta el reinicio si el uso llega al techo', () => {
    const r = decidir(entrada({ uso: { claude: uso(88), codex: uso(90) }, tareas: [tarea('a'), tarea('b')] }), CONFIG_BASE, null);
    assert.deepEqual(r.decisiones, []);
    assert.equal(r.resumen.modo, 'bloqueado');
    assert.ok(r.diferidas.every((d) => d.hasta === REINICIO), 'esperan al reinicio');
    assert.match(r.diferidas[0]!.motivo, /agotada/);
  });
  it('admisión: el coste p80 debe caber en el presupuesto; backfilling deja pasar a la pequeña si la cabeza no cabe', () => {
    // techo ≈ 90 − reserva prorateada (12·4/7 ≈ 6,9) = 83,1; con uso 80 caben ~3 puntos: N5 (p80 ≈ 8) no, N1 (≈ 0,5) sí.
    const grande = tarea('grande', { prioridad: 'alta', clasificacion: { nivel_tarea: 'level_5_critical', dominio: 'security' } });
    const pequena = tarea('pequena', { clasificacion: { nivel_tarea: 'level_1_simple', dominio: 'documents' } });
    const e = entrada({ tareas: [grande, pequena], uso: { claude: uso(80), codex: uso(0, 0) }, agentes: { claude: { disponible: true, enCurso: 0 }, codex: { disponible: false, enCurso: 0 } } });
    const con = decidir(e, CONFIG_BASE, null);
    assert.deepEqual(con.decisiones.map((d) => d.tarea), ['pequena']);
    assert.match(con.diferidas.find((d) => d.tarea === 'grande')!.motivo, /no cabe/);
    const sin = decidir(e, cfgCon({ cola: { backfill: false } }), null);
    assert.deepEqual(sin.decisiones, []);
    assert.match(sin.diferidas.find((d) => d.tarea === 'pequena')!.motivo, /cola estricta/);
  });
  it('lo comprometido en vuelo cuenta: el lease de una tarea ya decidida resta presupuesto y su decisión es estable', () => {
    const e1 = entrada({ tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(81), codex: uso(0) } });
    const r1 = decidir(e1, CONFIG_BASE, null);
    assert.equal(r1.decisiones.length, 1);
    const comprometido = r1.estado.leases['a']!.costePct;
    assert.ok(r1.agentes['claude']!.comprometidoPct === comprometido && comprometido > 0);
    // Misma tarea de nuevo (el host aún no la lanzó): misma decisión, sin contarla dos veces.
    const r2 = decidir(entrada({ ahora: AHORA + MIN, tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(81), codex: uso(0) } }), CONFIG_BASE, r1.estado);
    assert.equal(r2.decisiones.length, 1);
    assert.equal(r2.decisiones[0]!.motivo, r1.decisiones[0]!.motivo);
    assert.equal(Object.keys(r2.estado.leases).length, 1);
    // Otra tarea fijada a Claude: no cabe porque la primera ya ocupa el presupuesto restante.
    const r3 = decidir(entrada({ tareas: [tarea('b', { agente: 'claude' })], uso: { claude: uso(81), codex: uso(0) } }), cfgCon({ concurrencia: { porAgente: { claude: 3 } } }), r1.estado);
    assert.deepEqual(r3.decisiones, []);
    assert.match(r3.diferidas[0]!.motivo, /no cabe|guarda/);
    // Los leases caducan solos.
    const r4 = decidir(entrada({ ahora: AHORA + 3 * HORA, tareas: [], leido: new Date(AHORA + 3 * HORA).toISOString(), uso: { claude: uso(81, 5, { reinicio: new Date(REINICIO).toISOString() }), codex: uso(0) } }), CONFIG_BASE, r1.estado);
    assert.deepEqual(r4.estado.leases, {});
  });
  it('ventana de 5 h: si la tarea no cabe en el tope se espera al reinicio de la ventana', () => {
    const e = entrada({ tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(20, 88), codex: uso(20, 5) } });
    const r = decidir(e, CONFIG_BASE, null);
    assert.deepEqual(r.decisiones, []);
    assert.equal(r.diferidas[0]!.hasta, AHORA + 3 * HORA);
    assert.match(r.diferidas[0]!.motivo, /5 h/);
    const holgada = decidir(entrada({ tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(20, 40), codex: uso(20, 5) } }), CONFIG_BASE, null);
    assert.equal(holgada.decisiones.length, 1);
    // sin % semanal (Claude suele darlo nulo) rige solo la ventana de 5 h y no se pacea
    const sinSemanal = decidir(entrada({ tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(null, 30), codex: uso(20, 5) } }), CONFIG_BASE, null);
    assert.equal(sinSemanal.decisiones.length, 1);
    assert.match(sinSemanal.decisiones[0]!.motivo, /sin % semanal/);
    assert.equal(decidir(entrada({ tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(null, 99), codex: uso(20, 5) } }), CONFIG_BASE, null).decisiones.length, 0);
  });
  it('horario de silencio: nada se lanza en esas horas y se difiere hasta el final', () => {
    const cfg = cfgCon({ horario: { zona: 'UTC', silencio: { desde: 22, hasta: 6 } } });
    const noche = Date.UTC(2026, 10, 4, 23, 0);
    const r = decidir(entrada({ ahora: noche, leido: new Date(noche).toISOString(), uso: { claude: uso(40, 5, { reinicio: new Date(REINICIO).toISOString() }), codex: uso(40) } }), cfg, null);
    assert.deepEqual(r.decisiones, []);
    assert.equal(r.diferidas[0]!.hasta, Date.UTC(2026, 10, 5, 6, 0));
    assert.equal(decidir(entrada(), cfg, null).decisiones.length > 0, true, 'a mediodía sí');
  });
  it('un retraso largo no se promete: si el ritmo pide esperar más del máximo, se difiere', () => {
    // Cubo de 1 punto y espera máxima de 20 min: la segunda tarea tendría que esperar casi una hora.
    const cfg = cfgCon({ concurrencia: { porAgente: { claude: 5, codex: 0 }, porEquipo: 5 }, pacing: { maxRafagaPct: 1, retrasoMaxMin: 20 } });
    const r = decidir(entrada({ tareas: [tarea('a', { agente: 'claude' }), tarea('b', { agente: 'claude' })], uso: { claude: uso(10), codex: uso(10) } }), cfg, null);
    assert.deepEqual(r.decisiones.map((d) => d.tarea), ['a']);
    assert.equal(r.diferidas[0]!.tarea, 'b');
    assert.match(r.diferidas[0]!.motivo, /ritmo: toca esperar/);
    assert.ok(r.diferidas[0]!.hasta! > AHORA + 20 * MIN);
    assert.ok(r.estado.buckets['claude']!.nivel < 1, 'solo la tarea decidida gasta fichas');
  });
  it('en modo frenado la decisión sale con lanzarEn en el futuro; por debajo de la línea sale ya (null)', () => {
    const cfg = cfgCon({ pacing: { bandaMuertaPct: 0, histeresisCiclos: 1, retrasoMaxMin: 600 } });
    const adelantado = entrada({ tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(45), codex: uso(40) } });
    const est = decidir(adelantado, cfg, null).estado;
    const r = decidir(adelantado, cfg, est);
    assert.equal(r.agentes['claude']!.modo, 'frenado');
    if (r.decisiones.length) assert.ok(r.decisiones[0]!.lanzarEn! > AHORA);
    const atrasado = decidir(entrada({ tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(10), codex: uso(40) } }), cfg, null);
    assert.equal(atrasado.decisiones[0]!.lanzarEn, null);
    assert.equal(atrasado.agentes['claude']!.modo, 'normal');
  });
  it('propiedad: más margen de seguridad ⇒ el retraso de la decisión es mayor o igual', () => {
    let anterior = -1;
    for (const margen of [0, 10, 20, 30]) {
      const cfg = cfgCon({ margenSeguridadPct: margen, pacing: { bandaMuertaPct: 0, histeresisCiclos: 1, retrasoMaxMin: 10_080 } });
      const e = entrada({ tareas: [tarea('a', { agente: 'claude' })], uso: { claude: uso(33), codex: uso(40) } });
      const est = decidir(e, cfg, null).estado;
      const r = decidir(e, cfg, est);
      const espera = r.decisiones.length ? (r.decisiones[0]!.lanzarEn ?? AHORA) - AHORA : Infinity;
      assert.ok(espera >= anterior, `margen ${margen}: ${espera} < ${anterior}`);
      anterior = espera;
    }
  });
  it('aislamiento: lo que pasa con un agente no bloquea al otro (concurrencia, circuito, cuota, disponibilidad)', () => {
    const base = entrada({ tareas: [tarea('c', { agente: 'claude' }), tarea('x', { agente: 'codex' })] });
    const solo = (e: EntradaDosificador, est: EstadoDosificador | null = null) => decidir(e, CONFIG_BASE, est).decisiones.map((d) => d.tarea).sort();
    assert.deepEqual(solo(base), ['c', 'x']);
    assert.deepEqual(solo({ ...base, agentes: { claude: { disponible: true, enCurso: 0 }, codex: { disponible: true, enCurso: 1 } } }), ['c'], 'Codex ocupado no frena a Claude');
    assert.deepEqual(solo({ ...base, agentes: { claude: { disponible: true, enCurso: 1 }, codex: { disponible: true, enCurso: 0 } } }), ['x'], 'ni al revés');
    assert.deepEqual(solo(base, registrarLimite(estadoInicial(), CONFIG_BASE, 'codex', AHORA + HORA, AHORA)), ['c']);
    assert.deepEqual(solo({ ...base, uso: { claude: uso(40), codex: uso(95) } }), ['c']);
    assert.deepEqual(solo({ ...base, uso: { claude: uso(95), codex: uso(40) } }), ['x']);
    assert.deepEqual(solo({ ...base, agentes: { claude: { disponible: false, enCurso: 0 }, codex: { disponible: true, enCurso: 0 } } }), ['x']);
  });
  it('sin inanición: con aging, una tarea mínima vieja acaba pasando por delante de las normales nuevas', () => {
    const cfg = cfgCon({ cola: { agingPorHora: 5 }, concurrencia: { porAgente: { claude: 1, codex: 0 } } });
    const decidida = (horas: number) => {
      const ahora = AHORA;
      const vieja = tarea('vieja', { prioridad: 'minima', creada: ahora - horas * HORA, agente: 'claude' });
      const nuevas = ['n1', 'n2', 'n3'].map((id) => tarea(id, { prioridad: 'normal', creada: ahora - 5 * MIN, agente: 'claude' }));
      return decidir(entrada({ ahora, tareas: [...nuevas, vieja] }), cfg, null).decisiones.map((d) => d.tarea);
    };
    assert.deepEqual(decidida(1), ['n1'], 'recién llegada pierde frente a las normales');
    assert.deepEqual(decidida(11), ['vieja'], 'tras ~10 h de espera (50 puntos de aging) pasa la primera');
    // con prioridad crítica llegando sin parar, la baja también acaba saliendo
    const flujo = (h: number) => decidir(entrada({ tareas: [tarea('baja', { prioridad: 'baja', creada: AHORA - h * HORA, agente: 'claude' }), tarea('crit', { prioridad: 'critica', creada: AHORA, agente: 'claude' })] }), cfg, null).decisiones[0]!.tarea;
    assert.equal(flujo(1), 'crit');
    assert.equal(flujo(20), 'baja');
  });
  it('colocación: afinidad al repo ya preparado, equipo preferido, menos carga y equipos caídos se saltan', () => {
    const equipos = [
      { id: 'pc', disponible: true, enCurso: { claude: 0, codex: 0 }, repos: ['atlas'] },
      { id: 'servidor', disponible: true, enCurso: { claude: 0, codex: 0 }, repos: ['otro'] },
    ];
    const una = (t: TareaEntrada, eq = equipos) => decidir(entrada({ tareas: [t], equipos: eq }), CONFIG_BASE, null).decisiones[0]!.equipo;
    assert.equal(una(tarea('a', { agente: 'claude', repo: 'otro' })), 'servidor', 'el repo ya está preparado allí');
    assert.equal(una(tarea('a', { agente: 'claude', repo: 'atlas' })), 'pc');
    assert.equal(una(tarea('a', { agente: 'claude', equipo: 'servidor' })), 'servidor', 'equipo preferido');
    assert.equal(una(tarea('a', { agente: 'claude' }), [{ ...equipos[0]!, enCurso: { claude: 0, codex: 1 } }, equipos[1]!]), 'servidor', 'menos carga');
    assert.equal(una(tarea('a', { agente: 'claude', repo: 'atlas' }), [{ ...equipos[0]!, disponible: false }, equipos[1]!]), 'servidor', 'equipo no disponible: se salta');
    const ocupado = decidir(entrada({ tareas: [tarea('a', { agente: 'claude' })], equipos: equipos.map((e) => ({ ...e, enCurso: { claude: 1, codex: 0 } })) }), CONFIG_BASE, null);
    assert.deepEqual(ocupado.decisiones, [], 'ningún equipo con hueco para Claude');
    assert.match(ocupado.diferidas[0]!.motivo, /ningún equipo libre/);
  });
  it('colocación: el agente preferido por tipo gana, y si no, el de más presupuesto relativo', () => {
    const e = entrada({ tareas: [tarea('a', { clasificacion: { nivel_tarea: '2', dominio: 'programming', intencion: 'diagnose_and_fix' } })], uso: { claude: uso(30), codex: uso(10) } });
    assert.equal(decidir(e, CONFIG_BASE, null).decisiones[0]!.agente, 'codex', 'Codex va más holgado');
    assert.equal(decidir({ ...e, uso: { claude: uso(10), codex: uso(30) } }, CONFIG_BASE, null).decisiones[0]!.agente, 'claude');
    const pref = cfgCon({ afinidad: { agentePorTipo: { diagnose_and_fix: 'claude' } } });
    assert.equal(decidir(e, pref, null).decisiones[0]!.agente, 'claude');
    const cae = decidir({ ...e, agentes: { claude: { disponible: false, enCurso: 0 }, codex: { disponible: true, enCurso: 0 } } }, pref, null);
    assert.equal(cae.decisiones[0]!.agente, 'codex', 'si el preferido no sirve, cae al otro');
  });
  it('las tareas programadas en el futuro y los ids repetidos se ignoran', () => {
    const r = decidir(entrada({ tareas: [tarea('a', { programada: AHORA + HORA }), tarea('b'), tarea('b')] }), CONFIG_BASE, null);
    assert.ok(r.decisiones.every((d) => d.tarea === 'b'));
    assert.equal(r.decisiones.filter((d) => d.tarea === 'b').length, 1);
    assert.ok(![...r.diferidas, ...r.decisiones].some((d) => d.tarea === 'a'));
  });
  it('el cubo de fichas espacia las ráfagas: con concurrencia amplia no se lanza todo de golpe', () => {
    const cfg = cfgCon({ concurrencia: { porAgente: { claude: 10, codex: 0 }, porEquipo: 10 }, pacing: { maxRafagaPct: 3 } });
    const e = entrada({ tareas: ['a', 'b', 'c', 'd', 'e'].map((id) => tarea(id, { agente: 'claude' })), equipos: [{ id: 'pc', disponible: true, enCurso: {}, repos: [] }, { id: 'srv', disponible: true, enCurso: {}, repos: [] }] });
    const r = decidir(e, cfg, null);
    // una decisión como mucho por agente y equipo: con dos equipos, dos
    assert.ok(r.decisiones.length <= 2);
    const asap = decidir(e, cfgCon({ concurrencia: { porAgente: { claude: 10, codex: 0 }, porEquipo: 10 }, pacing: { modo: 'asap' } }), null);
    assert.ok(asap.decisiones.every((d) => d.lanzarEn === null), 'en asap no hay cubo ni retraso');
  });
});

describe('contrato de entrada', () => {
  const ok = () => JSON.parse(JSON.stringify(entrada())) as Record<string, unknown>;
  it('acepta la entrada del contrato y rellena lo opcional', () => {
    const v = validarEntrada({ ...ok(), tareas: [{ id: 'x', prioridad: 'alta', creada: 1, programada: null, agente: 'auto' }] }, CONFIG_BASE);
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.entrada.tareas[0]!.clasificacion, { nivel_tarea: undefined, dominio: undefined, intencion: undefined });
  });
  it('lo inválido da un mensaje y nunca lanza', () => {
    const malos: unknown[] = [null, 5, 'x', [], {}, { ...ok(), ahora: 'ya' }, { ...ok(), tareas: 'no' }, { ...ok(), tareas: [{ id: '', prioridad: 'normal', creada: 1 }] },
      { ...ok(), tareas: [{ id: 'a', prioridad: 'urgente', creada: 1 }] }, { ...ok(), tareas: [{ id: 'a', prioridad: 'normal', creada: 'ayer' }] }, { ...ok(), tareas: [{ id: 'a', prioridad: 'normal', creada: 1, agente: 'gpt' }] },
      { ...ok(), equipos: [{ id: 'a', disponible: 'si' }] }, { ...ok(), agentes: { claude: 3 } }, { ...ok(), uso: null }, { ...ok(), leido: 'nunca' }];
    for (const m of malos) {
      const v = validarEntrada(m, CONFIG_BASE);
      assert.equal(v.ok, false, JSON.stringify(m)?.slice(0, 80));
      if (!v.ok) assert.ok(v.error.length > 3);
    }
  });
});
