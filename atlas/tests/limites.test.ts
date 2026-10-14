import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { Almacen } from '../src/almacen';
import { Delegador } from '../src/delegar';
import { claudeExcedido, leerLimites } from '../src/limites';
import { Perfiles } from '../src/perfiles';
import type { Disponibilidad, Ejecutor, Proveedor } from '../src/proveedores';

/** Claude por encima del 50 % semanal: lo suyo pasa a Codex con su aviso; forzado a mano, sigue en Claude. */
const base = mkdtempSync(join(tmpdir(), 'karajan-limites-'));
after(() => rmSync(base, { recursive: true, force: true }));

describe('límites del plan', () => {
  it('lee el fichero y descarta datos de más de dos horas', () => {
    const ruta = join(base, 'limites-plan.json');
    writeFileSync(ruta, JSON.stringify({ claude: { semanal: 63 }, leido: new Date().toISOString() }));
    assert.equal(claudeExcedido(leerLimites(Date.now(), ruta)), 63);
    writeFileSync(ruta, JSON.stringify({ claude: { semanal: 63 }, leido: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    assert.equal(leerLimites(Date.now(), ruta), null);
    assert.equal(claudeExcedido({ claude: { semanal: 40 }, leido: new Date().toISOString() }), null);
    assert.equal(claudeExcedido(null), null);
  });

  describe('al delegar', () => {
    const perfiles = new Perfiles(join(base, 'routing_layout.json'));
    perfiles.aplicarPresetNivel();
    // La heurística rara vez llega a N4: Claude atiende aquí todos los niveles para probar la desviación.
    perfiles.desdeTexto('Claude para N1 a N5', { aplicar: true });
    const almacen = new Almacen(join(base, 'task_logs.db'));
    after(() => almacen.cerrar());
    const ejecutor: Ejecutor = async (_p, modelo) => ({ salida: 'ok', error: null, latenciaMs: 1, modelo });
    const todos = (p: Proveedor): Disponibilidad => ({ nombre: p.nombre, etiqueta: p.etiqueta, gratis: p.gratis, disponible: true, ruta: 'x', motivo: null, login: p.login });
    const con = (semanal: number) => new Delegador({ almacen, perfiles, config: () => null as never, raiz: base, ejecutor, disponible: todos, limites: () => ({ claude: { semanal }, leido: new Date().toISOString() }) });
    const complejo = 'Revisa la arquitectura del sistema distribuido y decide si migrar a microservicios, con riesgo en producción';

    it('por debajo del umbral, lo complejo va a Claude', () => {
      assert.ok(con(30).planificar(complejo).asignaciones.some((a) => a.proveedor === 'claude-cli'));
    });

    it('por encima, pasa a Codex, lo anota y se puede forzar Claude', async () => {
      const d = con(63);
      const plan = d.planificar(complejo);
      const desviadas = plan.asignaciones.filter((a) => a.limite !== undefined);
      assert.ok(desviadas.length > 0);
      assert.ok(desviadas.every((a) => a.proveedor === 'codex' && /63 %/.test(a.motivo)));
      assert.ok(d.planificar(complejo, 'nivel-claude').asignaciones.every((a) => a.proveedor === 'claude-cli' && a.limite === undefined));
      const delegada = d.delegar(complejo, { aprobada: true });
      await Promise.all([...d.pendientes]);
      assert.ok(almacen.decisiones(delegada.task_id).some((x) => x['decision'] === 'limite_semanal:claude->codex'));
    });
  });
});
