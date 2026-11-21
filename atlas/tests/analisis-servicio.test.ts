import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ErrorServicio, ServicioAnalisis } from '../src/analisis/servicio';
import type { Backend } from '../src/analisis/proveedores';
import { falso, OK } from './ayuda-analisis';

let raiz: string, datos: string, registros: string;
beforeEach(() => { raiz = mkdtempSync(join(tmpdir(), 'analisis-srv-')); datos = join(raiz, 'datos'); registros = join(raiz, 'registros'); mkdirSync(datos, { recursive: true }); });
afterEach(() => rmSync(raiz, { recursive: true, force: true }));

function tarea(id: string, estado = 'completada') {
  const c = join(registros, 'validadas', `${id}_t`);
  mkdirSync(c, { recursive: true });
  writeFileSync(join(c, 'tarea.json'), JSON.stringify({ version: 1, motivo: 'validada', tarea: { id, titulo: `T ${id}`, tipo: 'tarea', estado, prompt: 'Añade un endpoint' }, hoja: { agente: 'claude', revisada: true }, cabecera: null, eventos: [], informe: 'ok' }));
  return c;
}
const JSON_OK = '{"nivel":"simple","dominio":"backend","tipo":"feature","confianza":0.8,"razon":"x"}';
const servicio = (backend: Backend, extra: Partial<ConstructorParameters<typeof ServicioAnalisis>[0]> = {}) => new ServicioAnalisis({ datos, backend, env: { ATLAS_REGISTRO_DIR: registros }, ...extra });

describe('servicio de análisis', () => {
  it('procesa el registro, lo deja en estado y lo exporta para dpw7; la segunda pasada no repite nada', async () => {
    const carpeta = tarea('aa11');
    const { backend, llamadas } = falso({ ollama: OK }, { ollama: JSON_OK });
    const s = servicio(backend);
    assert.equal((await s.procesar()).contadores.analizada, 1);
    assert.equal((await s.procesar()).contadores.omitida, 1);
    assert.equal(llamadas.length, 1);
    assert.ok(existsSync(join(carpeta, 'analisis.json')));
    const e = s.estado();
    assert.equal(e.total, 1); assert.equal(e.por_estado['ok'], 1); assert.equal(e.ultimo_informe?.contadores.omitida, 1);
    assert.equal(s.exportar().muestras[0]?.nivel, 'simple');
    assert.equal(s.tarea('aa11').proceso.estado, 'ok');
    assert.throws(() => s.tarea('zz99'), (err) => err instanceof ErrorServicio && err.estado === 404);
  });

  it('usa la cola de Atlas dev solo si está configurada y un fallo de la cola no impide procesar el registro', async () => {
    tarea('aa11');
    const { backend } = falso({ ollama: OK }, { ollama: JSON_OK });
    const cola = { async tareas(): Promise<never> { throw new Error('Atlas dev respondió 500'); } };
    const inf = await servicio(backend, { atlasDev: cola }).procesar();
    assert.equal(inf.contadores.analizada, 1);
    assert.equal(inf.fuentes.cola?.ok, false);
    assert.match(inf.fuentes.cola?.error ?? '', /500/);
    assert.match(readFileSync(join(datos, 'analisis', 'bitacora.jsonl'), 'utf8'), /cola-inaccesible/);
  });

  it('sin carpeta de registro falla con 422 y con registro inexistente lo anota sin lanzar', async () => {
    const { backend } = falso({}, {});
    await assert.rejects(new ServicioAnalisis({ datos, backend, env: {} }).procesar(), (e) => e instanceof ErrorServicio && e.estado === 422);
    const inf = await new ServicioAnalisis({ datos, backend, env: { ATLAS_REGISTRO_DIR: join(raiz, 'no-existe') } }).procesar();
    assert.equal(inf.fuentes.registro.ok, false);
  });

  it('no admite dos pasadas a la vez (409) y libera el cerrojo al terminar', async () => {
    tarea('aa11');
    let soltar!: () => void;
    const backend: Backend = { sondear: async () => OK, generar: () => new Promise((r) => { soltar = () => r({ salida: JSON_OK, error: null, latenciaMs: 1, modelo: 'm' }); }) };
    const s = servicio(backend);
    const primera = s.procesar();
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(s.procesar(), (e) => e instanceof ErrorServicio && e.estado === 409);
    soltar(); await primera;
    assert.equal((await s.procesar()).contadores.omitida, 1);
  });

  it('la configuración se mezcla, se valida y persiste', () => {
    const s = servicio(falso({}, {}).backend);
    assert.equal(s.config().permitirGemini, true);
    const c = s.guardarConfig({ permitirGemini: false, limitePorEjecucion: 'mucho', destilacion: { activa: true } });
    assert.equal(c.permitirGemini, false); assert.equal(c.limitePorEjecucion, 20); assert.equal(c.destilacion.activa, true);
    assert.equal(c.destilacion.proveedor, 'claude-cli');
    assert.equal(servicio(falso({}, {}).backend).config().permitirGemini, false);
  });

  it('destilar apagada no llama a ningún modelo; activa y con evidencia propone un borrador y no toca la taxonomía', async () => {
    for (let i = 0; i < 3; i++) tarea(`b${i}`);
    const sin = falso({ ollama: OK }, { ollama: '{"nivel":"simple","dominio":"robotica","tipo":"feature"}' });
    const s = servicio(sin.backend);
    await s.procesar();
    const apagada = await s.destilar();
    assert.equal(apagada.acciones.length, 0); assert.match(apagada.motivo ?? '', /desactivada/);
    s.guardarConfig({ destilacion: { activa: true, proveedor: 'claude-cli', modelo: 'opus', minimoValores: 1 } });
    const propuestos: unknown[] = [];
    const dest = falso({ 'claude-cli': OK }, { 'claude-cli': '{"acciones":[{"eje":"dominio","original":"robotica","accion":"nuevo_termino","termino":"robotica","definicion":"Robots y hardware","razon":"3 tareas"}]}' });
    const s2 = servicio(dest.backend, { pasarela: { proponer: async (c, h) => { propuestos.push([c, h.clave]); return { clave: h.clave, tarea: 'x1', accion: 'creada' as const }; } } });
    const r = await s2.destilar();
    assert.equal(dest.llamadas.length, 1);
    assert.equal(r.acciones.length, 1);
    assert.equal(propuestos.length, 1);
    assert.ok(existsSync(join(datos, 'analisis', 'destilacion.json')));
  });
});
