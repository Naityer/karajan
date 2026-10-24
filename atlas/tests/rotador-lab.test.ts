import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ejecutarLaboratorio, RegistroLab } from '../src/laboratorio';
import { UMBRALES_ROTADOR, laboratorioRotador, mejoraClara, reproducirEnSandbox, type ContextoRotador } from '../src/lab/rotador.lab';
import { Rotador, simularRotacion, type ConfigRotador, type HistorialUso } from '../src/rotador';

/** Todo con datos sintéticos en temporales: ni el estado, ni las carpetas de skills, ni skills-uso.json son los del equipo. */
const raices: string[] = [];
const temporal = () => { const d = mkdtempSync(join(tmpdir(), 'kj-rotador-lab-test-')); raices.push(d); return d; };
after(() => { for (const d of raices) rmSync(d, { recursive: true, force: true }); });

const DIA = 86_400_000;
const INICIO = Date.parse('2026-01-01T00:00:00Z');
const fecha = (i: number) => new Date(INICIO + i * DIA).toISOString().slice(0, 10);
const CONFIG: ConfigRotador = { nucleoDias: 14, frecuenteDias: 45, instantaneaDias: 3, protegidas: [] };

const skill = (ruta: string) => { mkdirSync(ruta, { recursive: true }); writeFileSync(join(ruta, 'SKILL.md'), '---\nname: x\n---\n'); };

/** Escribe un skills-uso.json con el formato de Atlas dev (`dias` por skill) a partir de un historial. */
function escribirUso(dir: string, h: HistorialUso): string {
  const ruta = join(dir, 'skills-uso.json');
  const skills = Object.fromEntries(Object.entries(h).map(([s, dias]) => [s, { invocaciones: Object.values(dias).reduce((a, b) => a + b, 0), ultima: `${Object.keys(dias).sort().at(-1)}T12:00:00.000Z`, dias }]));
  writeFileSync(ruta, JSON.stringify({ 'sesion.jsonl': { tam: 1, mtime: 1, v: 2, skills } }));
  return ruta;
}

function contexto(h: HistorialUso, ahora: number, estado: Partial<{ config: Partial<ConfigRotador> }> = {}): { ctx: ContextoRotador; casa: string; rotador: Rotador } {
  const casa = temporal();
  writeFileSync(join(casa, 'rotador.json'), JSON.stringify(estado));
  const rotador = new Rotador({ casa, estado: join(casa, 'rotador.json'), usoAtlas: escribirUso(casa, h), ahora: () => ahora });
  return { casa, rotador, ctx: { rotador, historial: () => rotador.historial(), ahora: () => ahora, tareas: async () => [], calibraciones: () => [] } };
}

/** 20 skills de uso diario y 3 que se usan cada 50 días (desfasadas): con frecuente = 45 cada uso periódico es un fallo; con 60, ninguno. */
function historialPeriodico(dias: number): HistorialUso {
  const h: HistorialUso = {};
  for (let k = 0; k < 20; k++) for (let i = 0; i < dias; i++) (h[`diaria-${k}`] ??= {})[fecha(i)] = 1;
  for (let k = 0; k < 3; k++) for (let i = k * 7; i < dias; i += 50) (h[`rara-${k}`] ??= {})[fecha(i)] = 1;
  return h;
}

const escenario = (id: string) => laboratorioRotador.escenarios.find((e) => e.id === id)!;

describe('laboratorio del rotador · contrato', () => {
  it('sin problemas: configuración coherente, plan idempotente y las carpetas reales intactas', async () => {
    const ahora = Date.parse('2026-07-01T00:00:00Z');
    const { ctx, rotador } = contexto({ alfa: { '2026-06-25': 2 } }, ahora);
    skill(join(rotador.raiz('claude'), 'alfa'));
    skill(join(rotador.raiz('claude'), 'gamma')); // sin uso: el plan la retira
    skill(join(rotador.almacen('claude'), 'beta'));
    assert.equal(rotador.plan().retirar.length, 1);
    const r = await escenario('contrato').ejecutar(ctx);
    assert.deepEqual(r.hallazgos, []);
    assert.equal(r.suficiente, true);
    assert.equal(r.metricas['plan_retirar'], 1);
    assert.equal(r.metricas['plan_tras_aplicar'], 0);
    // Solo lectura: nada se movió en la casa de verdad.
    assert.ok(existsSync(join(rotador.raiz('claude'), 'gamma', 'SKILL.md')));
    assert.ok(!existsSync(join(rotador.almacen('claude'), 'gamma')));
  });

  it('da hallazgo con días incoherentes y con una skill instalada y en el almacén a la vez', async () => {
    const { ctx, rotador } = contexto({ alfa: { '2026-06-25': 1 } }, Date.parse('2026-07-01T00:00:00Z'), { config: { nucleoDias: 50 } });
    skill(join(rotador.raiz('claude'), 'alfa'));
    skill(join(rotador.almacen('claude'), 'alfa'));
    const r = await escenario('contrato').ejecutar(ctx);
    const claves = r.hallazgos.map((h) => h.clave).sort();
    assert.deepEqual(claves, ['config-incoherente', 'instalada-y-en-almacen']);
    assert.equal(r.hallazgos.find((h) => h.clave === 'config-incoherente')!.severidad, 'alta');
    assert.equal(r.metricas['config_coherente'], 0);
  });
});

describe('laboratorio del rotador · replay del historial', () => {
  it('la simulación pura coincide con el Rotador real en sandbox', () => {
    const h = historialPeriodico(130);
    assert.deepEqual(reproducirEnSandbox(h, CONFIG, UMBRALES_ROTADOR.calentamiento), simularRotacion(h, CONFIG, UMBRALES_ROTADOR.calentamiento));
  });

  it('recomienda otros días cuando el historial lo justifica', async () => {
    const h = historialPeriodico(170);
    const { ctx } = contexto(h, Date.parse('2026-07-30T00:00:00Z'));
    const base = simularRotacion(h, CONFIG, UMBRALES_ROTADOR.calentamiento);
    assert.ok(base.fallos >= UMBRALES_ROTADOR.fallosMinimos, `fallos con la config actual: ${base.fallos}`);
    const r = await escenario('historial').ejecutar(ctx);
    assert.equal(r.suficiente, true);
    const hallazgo = r.hallazgos.find((x) => x.clave === 'dias-rotador');
    assert.ok(hallazgo, JSON.stringify(r.hallazgos));
    assert.equal(hallazgo.severidad, 'media');
    assert.match(hallazgo.propuesta, /frecuenteDias: 60/);
    assert.match(hallazgo.propuesta, /nucleoDias: 14/); // el núcleo no cambia el resultado: se conserva el actual
    assert.ok(!r.hallazgos.some((x) => x.clave === 'simulacion-infiel'));
    assert.ok((r.metricas['fallos'] as number) > 0);
  });

  it('no recomienda nada con una muestra corta (da las métricas pero no hallazgos)', async () => {
    const h = historialPeriodico(70); // < calentamiento + 30 días
    const { ctx } = contexto(h, Date.parse('2026-03-15T00:00:00Z'));
    const r = await escenario('historial').ejecutar(ctx);
    assert.equal(r.suficiente, false);
    assert.deepEqual(r.hallazgos, []);
    assert.equal(r.metricas['dias_historial'], 70);
  });

  it('no recomienda nada si la configuración actual ya es buena (todo se usa a diario)', async () => {
    const h: HistorialUso = {};
    for (let k = 0; k < 10; k++) for (let i = 0; i < 160; i++) (h[`diaria-${k}`] ??= {})[fecha(i)] = 1;
    const { ctx } = contexto(h, Date.parse('2026-07-01T00:00:00Z'));
    const r = await escenario('historial').ejecutar(ctx);
    assert.equal(r.suficiente, true);
    assert.deepEqual(r.hallazgos, []);
    assert.equal(r.metricas['fallos'], 0);
  });

  it('mejoraClara exige mejora de ≥ 15 % en un eje sin empeorar el otro más del margen', () => {
    const base = { dias: 100, usos: 100, fallos: 10, instaladasMedia: 20, movimientos: 5 };
    assert.equal(mejoraClara({ ...base, fallos: 4 }, base), true);
    assert.equal(mejoraClara({ ...base, fallos: 4, instaladasMedia: 22 }, base), false, 'más coste no compensa');
    assert.equal(mejoraClara({ ...base, fallos: 9 }, base), false, 'mejora insuficiente');
    assert.equal(mejoraClara({ ...base, instaladasMedia: 15 }, base), true);
    assert.equal(mejoraClara({ ...base, instaladasMedia: 15, fallos: 12 }, base), false);
  });

  it('el motor guarda el resultado y propone el hallazgo sin tocar nada', async () => {
    const h = historialPeriodico(170);
    const { ctx } = contexto(h, Date.parse('2026-07-30T00:00:00Z'));
    const registro = new RegistroLab(join(temporal(), 'lab.db'));
    const informe = await ejecutarLaboratorio({ id: 'rotador', version: 'test', laboratorio: laboratorioRotador }, ctx, registro, { pasarela: null });
    registro.cerrar();
    assert.deepEqual(informe.escenarios.map((e) => e.escenario), ['contrato', 'historial']);
    assert.ok(informe.escenarios.every((e) => e.metricas));
  });
});
