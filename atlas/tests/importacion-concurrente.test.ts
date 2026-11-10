import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Almacen } from '../src/almacen';
import { crearRuntime } from '../src/runtime';

test('importa una instantánea confirmada mientras otro proceso escribe en WAL', { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-import-procesos-'));
  const origen = join(dir, 'origen'); mkdirSync(origen);
  const ruta = join(origen, 'task_logs.db');
  new Almacen(ruta).cerrar();
  const fuente = new DatabaseSync(ruta);
  fuente.exec("PRAGMA journal_mode=WAL; INSERT INTO tasks(task_id,prompt,status,classification_json,created_at,updated_at) VALUES('confirmada','prueba','classified','{}','2026-01-01','2026-01-01')");
  fuente.close();
  const script = `const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA journal_mode=WAL; BEGIN IMMEDIATE; INSERT INTO tasks(task_id,prompt,status,classification_json,created_at,updated_at) VALUES('pendiente','prueba','classified','{}','2026-01-01','2026-01-01')");
    process.stdout.write('listo');
    process.stdin.once('data',()=>{ db.exec('ROLLBACK'); db.close(); process.exit(0); });`;
  const hijo = spawn(process.execPath, ['-e', script, ruta], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const anterior = process.env['ATLAS_KARAJAN_DATA'], compartir = process.env['ATLAS_KARAJAN_COMPARTIR'];
  process.env['ATLAS_KARAJAN_DATA'] = origen; process.env['ATLAS_KARAJAN_COMPARTIR'] = '0';
  try {
    await Promise.race([
      once(hijo.stdout!, 'data'),
      once(hijo, 'error').then(([error]) => { throw error; }),
      once(hijo, 'exit').then(([codigo]) => { throw new Error(`escritor terminó antes de tiempo: ${codigo}`); }),
    ]);
    const runtime = crearRuntime(join(dir, 'destino'));
    try { assert.equal(runtime.importada, true); assert.equal(runtime.almacen.contar(), 1); }
    finally { runtime.cerrar(); }
    const fin = once(hijo, 'exit');
    hijo.stdin!.write('terminar');
    const [codigo] = await fin;
    assert.equal(codigo, 0);
    const verificar = new DatabaseSync(ruta, { readOnly: true });
    try { assert.equal(Number(verificar.prepare('SELECT COUNT(*) AS total FROM tasks').get()!.total), 1); }
    finally { verificar.close(); }
  } finally {
    if (hijo.exitCode === null && hijo.signalCode === null) { const fin = once(hijo, 'exit'); hijo.kill(); await fin; }
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    if (compartir === undefined) delete process.env['ATLAS_KARAJAN_COMPARTIR']; else process.env['ATLAS_KARAJAN_COMPARTIR'] = compartir;
    rmSync(dir, { recursive: true, force: true });
  }
});
