import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { crearRuntime } from '../src/runtime';
import { DatabaseSync } from 'node:sqlite';
import { calcularProduccion, produccion } from '../src/produccion';
import { Almacen } from '../src/almacen';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('el runtime se construye sin HTTP y cierra sus bases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-runtime-'));
  const anterior = process.env['ATLAS_KARAJAN_DATA'];
  delete process.env['ATLAS_KARAJAN_DATA'];
  try {
    const runtime = crearRuntime(dir);
    try { assert.equal(runtime.almacen.contar(), 0); assert.equal(runtime.guardian.modo(), 'produccion'); }
    finally { runtime.cerrar(); }
  } finally {
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la preparación compartida de analítica conserva el cálculo existente', () => {
  const ahora = new Date('2026-11-09T00:00:00Z');
  const catalogo = [{ nombre: 'ejemplo', instalada: true }];
  const actual = calcularProduccion([], { dias: '30', perfil: 'todos' }, {
    catalogo: () => catalogo, perfil: () => { throw new Error('no debe consultar perfil'); },
    disponibles: () => { throw new Error('no debe sondear proveedores'); }, ahora: () => ahora,
  });
  assert.deepEqual(actual, produccion([], { catalogo, agentesPerfil: null, dias: 30, ahora, noDisponibles: [], sinNivel: [] }));
});

test('una ruta explícita inexistente no crea una base alternativa', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-runtime-'));
  const anterior = process.env['ATLAS_KARAJAN_DATA'];
  process.env['ATLAS_KARAJAN_DATA'] = join(dir, 'ausente');
  try { assert.throws(() => crearRuntime(join(dir, 'destino')), /ATLAS_KARAJAN_DATA no existe/); }
  finally {
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un directorio fuente sin base no crea una instalación alternativa', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-runtime-'));
  const anterior = process.env['ATLAS_KARAJAN_DATA'];
  const compartir = process.env['ATLAS_KARAJAN_COMPARTIR'];
  process.env['ATLAS_KARAJAN_DATA'] = dir;
  process.env['ATLAS_KARAJAN_COMPARTIR'] = '0';
  try { assert.throws(() => crearRuntime(join(dir, 'destino')), /No existe task_logs.db/); }
  finally {
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    if (compartir === undefined) delete process.env['ATLAS_KARAJAN_COMPARTIR']; else process.env['ATLAS_KARAJAN_COMPARTIR'] = compartir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la importación toma una instantánea coherente con escrituras en WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-snapshot-'));
  const origen = join(dir, 'origen'); mkdirSync(origen);
  const ruta = join(origen, 'task_logs.db'); new Almacen(ruta).cerrar();
  const escritor = new DatabaseSync(ruta);
  escritor.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO tasks(task_id,prompt,status,classification_json,created_at,updated_at) VALUES('wal','prueba','classified','{}','2026-01-01','2026-01-01')");
  const anterior = process.env['ATLAS_KARAJAN_DATA'], compartir = process.env['ATLAS_KARAJAN_COMPARTIR'];
  process.env['ATLAS_KARAJAN_DATA'] = origen; process.env['ATLAS_KARAJAN_COMPARTIR'] = '0';
  try {
    const runtime = crearRuntime(join(dir, 'destino'));
    try { assert.equal(runtime.importada, true); assert.equal(runtime.almacen.contar(), 1); }
    finally { runtime.cerrar(); }
  } finally {
    escritor.close();
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    if (compartir === undefined) delete process.env['ATLAS_KARAJAN_COMPARTIR']; else process.env['ATLAS_KARAJAN_COMPARTIR'] = compartir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('una base de destino existente no se sobrescribe al importar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-snapshot-'));
  const origen = join(dir, 'origen'), destino = join(dir, 'destino');
  mkdirSync(origen); mkdirSync(destino);
  new Almacen(join(origen, 'task_logs.db')).cerrar();
  new Almacen(join(destino, 'task_logs.db')).cerrar();
  const escritor = new DatabaseSync(join(origen, 'task_logs.db'));
  escritor.exec("INSERT INTO tasks(task_id,prompt,status,classification_json,created_at,updated_at) VALUES('origen','prueba','classified','{}','2026-01-01','2026-01-01')");
  const anterior = process.env['ATLAS_KARAJAN_DATA'], compartir = process.env['ATLAS_KARAJAN_COMPARTIR'];
  process.env['ATLAS_KARAJAN_DATA'] = origen; process.env['ATLAS_KARAJAN_COMPARTIR'] = '0';
  try {
    const runtime = crearRuntime(destino);
    try { assert.equal(runtime.importada, false); assert.equal(runtime.almacen.contar(), 0); }
    finally { runtime.cerrar(); }
  } finally {
    escritor.close();
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    if (compartir === undefined) delete process.env['ATLAS_KARAJAN_COMPARTIR']; else process.env['ATLAS_KARAJAN_COMPARTIR'] = compartir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un bloqueo de importación impide abrir una base publicada a medias', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-bloqueo-'));
  const destino = join(dir, 'destino'); mkdirSync(destino);
  new Almacen(join(destino, 'task_logs.db')).cerrar();
  mkdirSync(join(destino, '.task-import-lock'));
  const anterior = process.env['ATLAS_KARAJAN_DATA'], compartir = process.env['ATLAS_KARAJAN_COMPARTIR'];
  delete process.env['ATLAS_KARAJAN_DATA']; process.env['ATLAS_KARAJAN_COMPARTIR'] = '0';
  try { assert.throws(() => crearRuntime(destino), /Importación en curso o interrumpida/); }
  finally {
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    if (compartir === undefined) delete process.env['ATLAS_KARAJAN_COMPARTIR']; else process.env['ATLAS_KARAJAN_COMPARTIR'] = compartir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un segundo proceso no abre el destino durante una importación', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-concurrencia-'));
  const destino = join(dir, 'destino'); mkdirSync(destino);
  new Almacen(join(destino, 'task_logs.db')).cerrar();
  const anterior = process.env['ATLAS_KARAJAN_DATA'], compartir = process.env['ATLAS_KARAJAN_COMPARTIR'];
  delete process.env['ATLAS_KARAJAN_DATA']; process.env['ATLAS_KARAJAN_COMPARTIR'] = '0';
  const hijo = spawn(process.execPath, ['-e', "require('fs').mkdirSync(process.argv[1]);process.stdout.write('listo');setInterval(()=>{},1000)", join(destino, '.task-import-lock')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    await Promise.race([once(hijo.stdout!, 'data'), once(hijo, 'error').then(([e]) => { throw e; }), once(hijo, 'exit').then(() => { throw new Error('el proceso de prueba terminó antes de crear el bloqueo'); })]);
    assert.throws(() => crearRuntime(destino), /Importación en curso o interrumpida/);
  } finally {
    if (hijo.exitCode === null && hijo.signalCode === null) { const fin = once(hijo, 'exit'); hijo.kill(); await fin; }
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    if (compartir === undefined) delete process.env['ATLAS_KARAJAN_COMPARTIR']; else process.env['ATLAS_KARAJAN_COMPARTIR'] = compartir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('un fallo después de publicar la base conserva el bloqueo de recuperación', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-fallo-importacion-'));
  const origen = join(dir, 'origen'), destino = join(dir, 'destino'); mkdirSync(origen);
  new Almacen(join(origen, 'task_logs.db')).cerrar();
  mkdirSync(join(origen, 'active_config.json')); // copiar un directorio como fichero falla
  const anterior = process.env['ATLAS_KARAJAN_DATA'], compartir = process.env['ATLAS_KARAJAN_COMPARTIR'];
  process.env['ATLAS_KARAJAN_DATA'] = origen; process.env['ATLAS_KARAJAN_COMPARTIR'] = '0';
  try {
    assert.throws(() => crearRuntime(destino));
    assert.equal(existsSync(join(destino, 'task_logs.db')), true);
    assert.equal(existsSync(join(destino, '.task-import-lock')), true);
    assert.throws(() => crearRuntime(destino), /Importación en curso o interrumpida/);
  } finally {
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    if (compartir === undefined) delete process.env['ATLAS_KARAJAN_COMPARTIR']; else process.env['ATLAS_KARAJAN_COMPARTIR'] = compartir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('la capa común no ejecuta una mutación si el guardián la deniega', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-runtime-'));
  const anterior = process.env['ATLAS_KARAJAN_DATA'];
  delete process.env['ATLAS_KARAJAN_DATA'];
  try {
    const runtime = crearRuntime(dir);
    try {
      runtime.guardian.exigir = async () => { throw new Error('denegada'); };
      let ejecutada = false;
      await assert.rejects(runtime.mutar({}, 'cambio', () => { ejecutada = true; }), /denegada/);
      assert.equal(ejecutada, false);
    } finally { runtime.cerrar(); }
  } finally {
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('una lectura convive con una transacción de escritura en WAL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-sqlite-'));
  const anterior = process.env['ATLAS_KARAJAN_DATA'];
  delete process.env['ATLAS_KARAJAN_DATA'];
  try {
    const runtime = crearRuntime(dir);
    const lector = new DatabaseSync(join(dir, 'task_logs.db'), { readOnly: true });
    const escritor = new DatabaseSync(join(dir, 'task_logs.db'));
    try {
      escritor.exec('BEGIN IMMEDIATE');
      escritor.exec('UPDATE tasks SET status = status WHERE 0');
      assert.equal(Number(lector.prepare('SELECT count(*) AS n FROM tasks').get()!.n), 0);
      assert.equal(runtime.almacen.contar(), 0);
      escritor.exec('ROLLBACK');
    } finally { lector.close(); escritor.close(); runtime.cerrar(); }
  } finally {
    if (anterior === undefined) delete process.env['ATLAS_KARAJAN_DATA']; else process.env['ATLAS_KARAJAN_DATA'] = anterior;
    rmSync(dir, { recursive: true, force: true });
  }
});
