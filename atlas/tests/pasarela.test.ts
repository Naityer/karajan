import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { AtlasDev } from '../src/atlas-dev';
import { Pasarela, type Hallazgo } from '../src/pasarela-borradores';
import { atlasFalso } from './ayuda-atlas';

const dir = mkdtempSync(join(tmpdir(), 'karajan-pasarela-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const h: Hallazgo = { clave: 'x', severidad: 'media', titulo: 'Algo que mejorar', evidencia: 'pasa esto', propuesta: 'haz aquello' };

describe('pasarela de borradores', () => {
  it('abre un borrador con la especificación y el origen, y no lo duplica', async () => {
    const a = atlasFalso();
    const p = new Pasarela(new AtlasDev('http://atlas', a.fetch), join(dir, 'b1.json'));
    const r1 = await p.proponer('delegador', h);
    assert.equal(r1.accion, 'creada');
    const t = a.tareas.get(r1.tarea!)!;
    assert.equal(t.estado, 'borrador');
    assert.match(t.titulo, /^\[karajan\] Algo que mejorar/);
    assert.match(t.prompt!, /## Evidencia[\s\S]*pasa esto[\s\S]*## Propuesta[\s\S]*Origen: karajan:delegador:x/);
    assert.equal((await p.proponer('delegador', h)).accion, 'sin-cambios');
    const r3 = await p.proponer('delegador', { ...h, evidencia: 'ahora pasa más' });
    assert.equal(r3.accion, 'actualizada');
    assert.equal(r3.tarea, r1.tarea);
    assert.match(a.tareas.get(r1.tarea!)!.prompt!, /ahora pasa más/);
    assert.equal(a.tareas.size, 1);
  });

  it('no reabre lo descartado ni toca lo aceptado; lo «baja» se queda en el informe', async () => {
    const a = atlasFalso();
    const p = new Pasarela(new AtlasDev('http://atlas', a.fetch), join(dir, 'b2.json'));
    const r = await p.proponer('selector', h);
    a.tareas.get(r.tarea!)!.estado = 'descartada';
    assert.equal((await p.proponer('selector', { ...h, evidencia: 'otra' })).accion, 'descartada-antes');
    const r2 = await p.proponer('selector', { ...h, clave: 'y' });
    a.tareas.get(r2.tarea!)!.estado = 'encolada';
    assert.deepEqual(await p.proponer('selector', { ...h, clave: 'y', evidencia: 'otra' }), { clave: 'selector:y', tarea: r2.tarea, accion: 'aceptada', detalle: 'encolada' });
    assert.equal((await p.proponer('selector', { ...h, clave: 'z', severidad: 'baja' })).accion, 'solo-informe');
    assert.equal(a.tareas.size, 2);
    assert.deepEqual((await p.listar()).map((x) => x.estado).sort(), ['descartada', 'encolada']);
  });

  it('si Atlas dev no responde no rompe: devuelve el error', async () => {
    const p = new Pasarela(new AtlasDev('http://atlas', async () => { throw new Error('ECONNREFUSED'); }), join(dir, 'b3.json'));
    const r = await p.proponer('x', h);
    assert.equal(r.accion, 'error');
    assert.match(r.detalle!, /ECONNREFUSED/);
  });
});
