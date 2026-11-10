import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crearAplicacion } from '../src/aplicacion';
import { type crearRuntime } from '../src/runtime';
import { crearAplicacionDosificador } from '../src/aplicacion-dosificador';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('operaciones reutilizables de aplicación', () => {
  it('aplica la autorización en las mutaciones incluso sin un adaptador HTTP', async () => {
    const acciones: string[] = [];
    let escrituras = 0;
    const runtime = {
      rutaLayout: '/layout',
      perfiles: { leer: () => ({}), guardar: () => { escrituras++; }, desdeTexto: (_t: string, o: { aplicar: boolean }) => ({ aplicado: o.aplicar }) },
      rotador: { plan: () => ({ cambios: [] }), aplicar: () => { escrituras++; return {}; } },
      mutar: async (_req: unknown, accion: string, ejecutar: () => unknown) => { acciones.push(accion); throw Object.assign(new Error('No autorizado'), { status: 423 }); },
      delegador: {},
    } as unknown as ReturnType<typeof crearRuntime>;
    const app = crearAplicacion(runtime);
    await assert.rejects(() => app.guardarPerfil({ body: {} }), { status: 423 });
    await assert.rejects(() => Promise.resolve(app.rotar({ body: { aplicar: true } })), { status: 423 });
    await assert.rejects(() => Promise.resolve(app.perfilDesdeTexto({ body: { texto: 'x', aplicar: true } })), { status: 423 });
    assert.equal(escrituras, 0);
    assert.deepEqual(acciones, ['PUT /routing-layout', 'POST /skills/rotar (aplicar)', 'POST /routing-layout/desde-texto']);
    assert.deepEqual(app.rotar({ body: {} }), { aplicado: false, cambios: [] });
    assert.deepEqual(app.perfilDesdeTexto({ body: { texto: 'x' } }), { aplicado: false });
  });

  it('valida los prompts también al invocar la aplicación directamente', () => {
    const runtime = { delegador: { planificar: (prompt: string) => ({ clasificacion: { prompt } }) } } as unknown as ReturnType<typeof crearRuntime>;
    const app = crearAplicacion(runtime);
    assert.throws(() => app.clasificar({ prompt: '  ' }), { status: 422, message: 'prompt cannot be blank' });
    assert.throws(() => app.planificar({ prompt: 'x'.repeat(20_001) }), { status: 422 });
    assert.deepEqual(app.clasificar({ prompt: '  tarea  ' }), { prompt: 'tarea' });
  });

  it('la búsqueda independiente aplica los mismos límites que la ruta HTTP', () => {
    const consultas: unknown[] = [];
    const runtime = { almacen: { buscar: (q: string, limite: number) => { consultas.push({ q, limite }); return ['resultado']; } } } as unknown as ReturnType<typeof crearRuntime>;
    const app = crearAplicacion(runtime);
    assert.deepEqual(app.buscarTareas({ q: 'ejemplo', limit: '500' }), { query: 'ejemplo', count: 1, results: ['resultado'] });
    app.buscarTareas({ limit: '-5' });
    app.buscarTareas({ limit: 'inválido' });
    assert.deepEqual(consultas, [{ q: 'ejemplo', limite: 100 }, { q: '', limite: 1 }, { q: '', limite: 20 }]);
  });

  it('el dosificador directo valida entradas y protege el cambio de configuración', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'karajan-aplicacion-dosificador-'));
    try {
      const mutar = (async () => { throw Object.assign(new Error('No autorizado'), { status: 423 }); }) as ReturnType<typeof crearRuntime>['mutar'];
      const app = crearAplicacionDosificador(dir, mutar);
      assert.deepEqual(app.tomarDecision(null), { error: 'el cuerpo debe ser un objeto' });
      assert.ok('error' in app.observar({ agente: 'desconocido' }));
      assert.ok('error' in app.relevo(null));
      await assert.rejects(() => app.cambiarConfig({ body: { margenSeguridadPct: 30 } }), { status: 423 });
      assert.equal(existsSync(join(dir, 'dosificador.json')), false);
      assert.equal(existsSync(join(dir, 'dosificador-estado.json')), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
