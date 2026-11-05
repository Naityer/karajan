import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CONFIG_BASE, MAX_REGISTRO_RELEVOS, estadoInicial, normalizarConfig, normalizarEstado } from '../src/dosificador-config';
import {
  DIA, HORA, MIN, decidir, decidirRelevo, despiertaEn, equipoDormido, registrarLimite, validarRelevo,
  type EntradaDosificador, type EntradaRelevo, type RelevoEntrada,
} from '../src/dosificador';

// Miércoles 4 nov 2026 12:00 UTC (13:00 en Madrid); el reinicio semanal es el domingo 8.
const AHORA = Date.UTC(2026, 10, 4, 12, 0, 0);
const REINICIO = AHORA + 4 * DIA;
const uso = (semanal: number | null, sesion: number | null = 5) => ({
  semanal, sesion, reinicio: new Date(REINICIO).toISOString(), reinicioSesion: new Date(AHORA + 3 * HORA).toISOString(), plan: 'max', fuente: 'test',
});
const relevo = (extra: Partial<RelevoEntrada> = {}): RelevoEntrada => ({
  id: 'r1', equipo: 'servidor', origen: 'pc', estadoOrigen: 'bloqueada', politica: null, agente: 'codex',
  ultimoLatido: AHORA - 2 * HORA, resetsAt: AHORA - 10 * MIN, intentos: 0, checkpoint: true, repo: 'atlas-dev', ...extra,
});
const entrada = (r: Partial<RelevoEntrada> = {}, extra: Partial<EntradaRelevo> = {}): EntradaRelevo => ({
  ahora: AHORA, relevo: relevo(r), agentes: { claude: { disponible: true, enCurso: 0 }, codex: { disponible: true, enCurso: 0 } },
  uso: { claude: uso(40), codex: uso(40) }, leido: new Date(AHORA - MIN).toISOString(), ...extra,
});
const cfgCon = (parcial: unknown) => normalizarConfig(parcial);

describe('config: tope, ritmo, equipos y relevo', () => {
  it('por defecto: el servidor duerme de 5 a 8, política «primero vivo», sin tope ni ritmo propios', () => {
    const c = normalizarConfig(null);
    assert.deepEqual(c.equipos['servidor'], { dormido: { desde: 5, hasta: 8 } });
    assert.equal(c.relevo.politicaDefecto, 'primero-vivo');
    assert.equal(c.relevo.tomarSiSilencio, true);
    assert.equal(c.planes['claude']!.topePct, null);
    assert.equal(c.planes['codex']!.ritmoMaxPctHora, null);
  });
  it('recorta los rangos y deja lo que no entiende en su valor por defecto', () => {
    const c = cfgCon({ planes: { claude: { topePct: 250, ritmoMaxPctHora: 'x' } }, relevo: { politicaDefecto: 'loco', silencioMin: 1, graciaMin: 9999, maxIntentos: 0 }, equipos: { portatil: { dormido: { desde: 23, hasta: 7 } }, 'mal nombre': {} } });
    assert.equal(c.planes['claude']!.topePct, 100);
    assert.equal(c.planes['claude']!.ritmoMaxPctHora, 100);
    assert.deepEqual(c.relevo, { politicaDefecto: 'primero-vivo', tomarSiSilencio: true, silencioMin: 5, graciaMin: 240, maxIntentos: 1 });
    assert.deepEqual(Object.keys(c.equipos), ['portatil']);
    assert.equal(cfgCon({ planes: { codex: { topePct: null } } }).planes['codex']!.topePct, null);
  });
  it('equipo dormido cruzando la medianoche y su despertar', () => {
    const c = cfgCon({ equipos: { portatil: { dormido: { desde: 23, hasta: 7 } } } });
    const a3h = Date.UTC(2026, 10, 4, 2, 0, 0); // 03:00 en Madrid
    assert.equal(equipoDormido(c, 'portatil', a3h), true);
    assert.equal(equipoDormido(c, 'portatil', AHORA), false);
    assert.equal(equipoDormido(c, 'pc', a3h), false, 'un equipo sin horario siempre está disponible');
    assert.equal(despiertaEn(c, 'portatil', a3h), Date.UTC(2026, 10, 4, 6, 0, 0), '07:00 en Madrid');
  });
  it('el estado guarda un registro de relevos acotado y tolera basura', () => {
    const e = normalizarEstado({ relevos: [...Array.from({ length: MAX_REGISTRO_RELEVOS + 5 }, (_, i) => ({ en: i, relevo: `r${i}`, accion: 'tomar' })), { en: 'x' }] });
    assert.equal(e.relevos.length, MAX_REGISTRO_RELEVOS);
    assert.equal(e.relevos.at(-1)!.relevo, `r${MAX_REGISTRO_RELEVOS + 4}`);
    assert.deepEqual(normalizarEstado(null).relevos, []);
  });
});

describe('decidir: tope, ritmo y equipo dormido', () => {
  const base = (extra: Partial<EntradaDosificador> = {}): EntradaDosificador => ({
    ahora: AHORA, tareas: [{ id: 't1', prioridad: 'normal', creada: AHORA - HORA, programada: null, agente: 'codex', clasificacion: { nivel_tarea: 'N2' } }],
    equipos: [{ id: 'pc', disponible: true, enCurso: {}, repos: [] }], agentes: { claude: { disponible: true, enCurso: 0 }, codex: { disponible: true, enCurso: 0 } },
    uso: { claude: uso(40), codex: uso(40) }, leido: new Date(AHORA - MIN).toISOString(), ...extra,
  });
  it('el tope del agente es un techo duro que no se pasa nunca', () => {
    const sin = decidir(base(), CONFIG_BASE);
    assert.equal(sin.decisiones.length, 1);
    const con = decidir(base(), cfgCon({ planes: { codex: { topePct: 40 } } }));
    assert.equal(con.decisiones.length, 0);
    assert.match(con.diferidas[0]!.motivo, /tope del agente/);
    assert.equal(con.agentes['codex']!.techoPct, 40);
  });
  it('por encima de la tasa de consumo máxima se difiere con el motivo «ritmo»', () => {
    const est = estadoInicial();
    est.muestras['codex'] = [{ t: AHORA - 2 * HORA, u: 20 }, { t: AHORA - HORA, u: 30 }]; // 10 %/h
    const r = decidir(base({ uso: { claude: uso(40), codex: uso(40) } }), cfgCon({ planes: { codex: { ritmoMaxPctHora: 5 } }, pacing: { modo: 'asap' } }), est);
    assert.equal(r.decisiones.length, 0);
    assert.match(r.diferidas[0]!.motivo, /ritmo: consumo de .* por encima del máximo 5 %\/h/);
    assert.equal(r.diferidas[0]!.hasta, AHORA + 30 * MIN);
  });
  it('no coloca en un equipo dormido y, si es el único, dice hasta cuándo', () => {
    const cfg = cfgCon({ equipos: { pc: { dormido: { desde: 12, hasta: 15 } } } }); // 13:00 en Madrid: dormido
    const r = decidir(base(), cfg);
    assert.equal(r.decisiones.length, 0);
    assert.match(r.diferidas[0]!.motivo, /equipo dormido/);
    assert.equal(r.diferidas[0]!.hasta, Date.UTC(2026, 10, 4, 14, 0, 0), '15:00 en Madrid');
    const dos = decidir(base({ equipos: [{ id: 'pc', disponible: true, enCurso: {}, repos: [] }, { id: 'servidor', disponible: true, enCurso: {}, repos: [] }] }), cfg);
    assert.equal(dos.decisiones[0]!.equipo, 'servidor', 'con otro equipo despierto, va a ese');
  });
});

describe('decidirRelevo', () => {
  it('bloqueada, cuota renovada y el origen callado: lo toma el destino con su agente', () => {
    const { decision, estado } = decidirRelevo(entrada(), CONFIG_BASE);
    assert.equal(decision.accion, 'tomar');
    assert.equal(decision.porque, 'cuota');
    assert.equal(decision.agente, 'codex');
    assert.match(decision.motivo, /cuota renovada/);
    assert.equal(estado.relevos.length, 1);
    assert.equal(estado.relevos[0]!.accion, 'tomar');
    assert.equal(estado.leases['r1'], undefined, 'no deja lease: la cola del destino decide con su propio id');
  });
  it('«primero vivo»: si el origen sigue dando latido, espera la gracia y no la toca', () => {
    const { decision } = decidirRelevo(entrada({ ultimoLatido: AHORA - MIN }), CONFIG_BASE);
    assert.equal(decision.accion, 'esperar');
    assert.match(decision.motivo, /sigue vivo/);
    assert.equal(decision.hasta, AHORA - MIN + CONFIG_BASE.relevo.graciaMin * MIN);
  });
  it('«auto»: la toma aunque el origen esté vivo', () => {
    assert.equal(decidirRelevo(entrada({ ultimoLatido: AHORA - MIN, politica: 'auto' }), CONFIG_BASE).decision.accion, 'tomar');
  });
  it('«preguntar»: nunca la toma sola', () => {
    const { decision } = decidirRelevo(entrada({ politica: 'preguntar' }), CONFIG_BASE);
    assert.equal(decision.accion, 'esperar');
    assert.equal(decision.hasta, null);
  });
  it('antes de la renovación espera hasta ella (más la gracia con «primero vivo»)', () => {
    const resetsAt = AHORA + HORA;
    assert.equal(decidirRelevo(entrada({ resetsAt }), CONFIG_BASE).decision.hasta, resetsAt + CONFIG_BASE.relevo.graciaMin * MIN);
    assert.equal(decidirRelevo(entrada({ resetsAt, politica: 'auto' }), CONFIG_BASE).decision.hasta, resetsAt);
  });
  it('sin hora de renovación usa el circuito del agente si lo hay', () => {
    const est = registrarLimite(estadoInicial(), CONFIG_BASE, 'codex', AHORA + 2 * HORA, AHORA - HORA);
    const { decision } = decidirRelevo(entrada({ resetsAt: null }), CONFIG_BASE, est);
    assert.equal(decision.accion, 'esperar');
    assert.match(decision.motivo, /se renueva/);
  });
  it('sin hora de renovación ni circuito: espera al silencio del origen', () => {
    const vivo = decidirRelevo(entrada({ resetsAt: null, ultimoLatido: AHORA - 10 * MIN }), CONFIG_BASE).decision;
    assert.equal(vivo.accion, 'esperar');
    assert.match(vivo.motivo, /sin hora de renovación/);
    assert.equal(decidirRelevo(entrada({ resetsAt: null, ultimoLatido: AHORA - 2 * HORA }), CONFIG_BASE).decision.accion, 'tomar');
  });
  it('origen trabajando: solo por silencio, y solo si está activado', () => {
    const trabajando = decidirRelevo(entrada({ estadoOrigen: 'ejecutando', resetsAt: null, ultimoLatido: AHORA - 10 * MIN }), CONFIG_BASE).decision;
    assert.equal(trabajando.accion, 'esperar');
    assert.equal(trabajando.porque, 'silencio');
    const callado = decidirRelevo(entrada({ estadoOrigen: 'ejecutando', resetsAt: null, ultimoLatido: AHORA - HORA }), CONFIG_BASE).decision;
    assert.equal(callado.accion, 'tomar');
    assert.match(callado.motivo, /60 min sin latido/);
    const apagado = decidirRelevo(entrada({ estadoOrigen: 'ejecutando', resetsAt: null, ultimoLatido: AHORA - HORA }), cfgCon({ relevo: { tomarSiSilencio: false } })).decision;
    assert.equal(apagado.accion, 'esperar');
  });
  it('sin checkpoint no se toma (se empezaría de cero)', () => {
    assert.equal(decidirRelevo(entrada({ checkpoint: false }), CONFIG_BASE).decision.accion, 'esperar');
  });
  it('agotados los intentos de arranque: cede', () => {
    const { decision } = decidirRelevo(entrada({ intentos: 3 }), CONFIG_BASE);
    assert.equal(decision.accion, 'ceder');
  });
  it('el destino dormido la pospone a su despertar', () => {
    const a6 = Date.UTC(2026, 10, 4, 5, 0, 0); // 06:00 en Madrid: el servidor duerme de 5 a 8
    const e = entrada({ resetsAt: a6 - HORA, ultimoLatido: a6 - 3 * HORA }, { ahora: a6, leido: new Date(a6 - MIN).toISOString() });
    const { decision } = decidirRelevo(e, CONFIG_BASE);
    assert.equal(decision.accion, 'esperar');
    assert.match(decision.motivo, /equipo dormido/);
    assert.equal(decision.hasta, Date.UTC(2026, 10, 4, 7, 0, 0), '08:00 en Madrid');
  });
  it('el tope del agente también manda en el relevo', () => {
    const { decision } = decidirRelevo(entrada(), cfgCon({ planes: { codex: { topePct: 35 } } }));
    assert.equal(decision.accion, 'esperar');
    assert.match(decision.motivo, /tope del agente/);
  });
  it('con agente «auto» elige el de más presupuesto', () => {
    const { decision } = decidirRelevo(entrada({ agente: 'auto' }, { uso: { claude: uso(20), codex: uso(70) } }), CONFIG_BASE);
    assert.equal(decision.agente, 'claude');
  });
  it('es puro: no muta el estado previo', () => {
    const previo = estadoInicial();
    const copia = JSON.stringify(previo);
    decidirRelevo(entrada(), CONFIG_BASE, previo);
    assert.equal(JSON.stringify(previo), copia);
  });
});

describe('validarRelevo', () => {
  it('acepta lo mínimo y normaliza', () => {
    const v = validarRelevo({ ahora: AHORA, relevo: { id: 'a', equipo: 'servidor', origen: 'pc', estadoOrigen: 'bloqueada', checkpoint: true }, agentes: {}, uso: {} }, CONFIG_BASE);
    assert.ok(v.ok);
    if (v.ok) { assert.equal(v.entrada.relevo.agente, 'auto'); assert.equal(v.entrada.relevo.politica, null); assert.equal(v.entrada.relevo.intentos, 0); }
  });
  it('rechaza lo que no encaja', () => {
    assert.equal(validarRelevo(null, CONFIG_BASE).ok, false);
    assert.equal(validarRelevo({ ahora: AHORA, relevo: { id: 'a', equipo: 'servidor' }, agentes: {}, uso: {} }, CONFIG_BASE).ok, false);
    assert.equal(validarRelevo({ ahora: AHORA, relevo: { id: 'a', equipo: 's', origen: 'pc', agente: 'gpt' }, agentes: {}, uso: {} }, CONFIG_BASE).ok, false);
    assert.equal(validarRelevo({ ahora: AHORA, relevo: { id: 'a', equipo: 's', origen: 'pc' }, agentes: { claude: {} }, uso: {} }, CONFIG_BASE).ok, false);
  });
});
