import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { geminiDisponible, leerLimites, type Limites } from '../src/limites';
import { MAX_INSTRUCCION_ARGUMENTO, PROVEEDORES, proveedor } from '../src/proveedores';

const ahora = Date.parse('2026-11-13T12:00:00Z');
const fresco = (semanal: number | null): Limites => ({ gemini: { semanal, fuente: 'plan' }, leido: new Date(ahora - 60_000).toISOString() });

describe('Gemini (Antigravity CLI): cuota y proveedor', () => {
  it('se elige solo con dato reciente y uso semanal por debajo del máximo (90 % por defecto)', () => {
    assert.equal(geminiDisponible(fresco(1)), true);
    assert.equal(geminiDisponible(fresco(89)), true);
    assert.equal(geminiDisponible(fresco(90)), false, 'en el máximo ya no se elige');
    assert.equal(geminiDisponible(fresco(100)), false);
  });

  it('sin dato, o con un dato caducado, no se elige: nunca se gasta cuota sin control', () => {
    assert.equal(geminiDisponible(null), false);
    assert.equal(geminiDisponible({ leido: new Date(ahora).toISOString() }), false, 'sin campo gemini');
    assert.equal(geminiDisponible(fresco(null)), false, 'uso desconocido');
  });

  it('un fichero de límites con más de dos horas se ignora (leerLimites devuelve null) y Gemini no se elige', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gemini-lim-'));
    const ruta = join(dir, 'limites-plan.json');
    writeFileSync(ruta, JSON.stringify({ gemini: { semanal: 1 }, leido: new Date(ahora - 3 * 3600_000).toISOString() }));
    try {
      assert.equal(leerLimites(ahora, ruta), null);
      assert.equal(geminiDisponible(leerLimites(ahora, ruta)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('el proveedor gemini-agy pasa la instrucción como argumento y nunca por stdin', () => {
    const p = proveedor('gemini-agy');
    assert.ok(p, 'existe en la tabla de proveedores');
    assert.equal(p.binario, 'agy');
    assert.equal(p.instruccionEnArgumento, true);
    const args = p.args('gemini-3.8-flash-medium', 'haz X');
    assert.deepEqual(args, ['-p', 'haz X', '--model', 'gemini-3.8-flash-medium', '--output-format', 'text']);
  });

  it('la tabla de proveedores no repite nombres y el límite de la instrucción está definido', () => {
    const nombres = PROVEEDORES.map((x) => x.nombre);
    assert.equal(new Set(nombres).size, nombres.length);
    assert.ok(MAX_INSTRUCCION_ARGUMENTO > 1000);
  });
});
