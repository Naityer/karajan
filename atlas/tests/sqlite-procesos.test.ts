import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Almacen } from '../src/almacen';
import { ejecutar } from '../src/cli';

const raiz = resolve(import.meta.dirname, '../..');
const pythonLocal = join(raiz, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env['KARAJAN_TEST_PYTHON'] || (existsSync(pythonLocal) ? pythonLocal : 'python');
const disponible = spawnSync(python, ['-c', 'from app.persistence.database import TaskStore'], { cwd: raiz, stdio: 'ignore' }).status === 0;

// El proceso utiliza la conexión del almacén Python real y mantiene el bloqueo
// hasta recibir la orden. Ningún proceso accede a datos fuera del directorio temporal.
const script = `
import sys
from app.persistence.database import TaskStore
store = TaskStore(sys.argv[1])
conn = store._connect()
conn.execute('BEGIN IMMEDIATE')
conn.execute("INSERT INTO tasks(task_id,prompt,status,classification_json,created_at,updated_at) VALUES('python','prueba','classified','{}','2026-01-01','2026-01-01')")
print('bloqueado', flush=True)
sys.stdin.readline()
conn.commit()
conn.close()
store.close()
`;

test('Python y TypeScript comparten WAL, respetan el bloqueo y reanudan escritura', { skip: !disponible }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-procesos-'));
  const ruta = join(dir, 'task_logs.db');
  const almacen = new Almacen(ruta);
  const hijo = spawn(python, ['-u', '-c', script, ruta], { cwd: raiz, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errores = '';
  hijo.stderr!.on('data', (chunk) => { errores += chunk.toString(); });
  const fin = once(hijo, 'exit');
  try {
    await Promise.race([
      once(hijo.stdout!, 'data'),
      fin.then(() => { throw new Error(`Python terminó antes del bloqueo: ${errores}`); }),
    ]);
    // WAL deja ver la última versión confirmada, no la fila aún pendiente.
    assert.equal(almacen.contar(), 0);
    let salida = '';
    const codigoCli = await ejecutar(['estadisticas', 'resumen', '--tasks-db', ruta, '--local', '--json'], {
      fetch: async () => { throw new Error('La lectura local no debe usar la red'); },
      api: 'http://no-disponible', escribir: (s) => { salida = s; },
    });
    assert.equal(codigoCli, 0);
    assert.equal(JSON.parse(salida).datos.kpis.tareas, 0);
    const tarea = { task_id: 'typescript', original_prompt: 'prueba', created_at: '2026-01-01', complexity_level: 'low', recommended_model: 'test', complexity_score: 0, requires_human_review: false, subtasks: [] };
    // El primer intento agota el busy_timeout, no inventa éxito ni pierde datos.
    assert.throws(() => almacen.guardarTarea(tarea, 'classified'), /locked|busy/i);
    hijo.stdin!.end('\n');
    const [codigo] = await fin;
    assert.equal(codigo, 0, errores);
    almacen.guardarTarea(tarea, 'classified');
    assert.equal(almacen.contar(), 2);
  } finally {
    if (hijo.exitCode === null && hijo.signalCode === null) { hijo.kill(); await fin; }
    almacen.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SQLite recupera una transacción Python interrumpida y permite nuevas escrituras', { skip: !disponible }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kj-recuperacion-'));
  const ruta = join(dir, 'task_logs.db');
  const almacen = new Almacen(ruta);
  const hijo = spawn(python, ['-u', '-c', script, ruta], { cwd: raiz, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let errores = '';
  hijo.stderr!.on('data', (chunk) => { errores += chunk.toString(); });
  const fin = once(hijo, 'exit');
  try {
    await Promise.race([
      once(hijo.stdout!, 'data'),
      fin.then(() => { throw new Error(`Python terminó antes del bloqueo: ${errores}`); }),
    ]);
    hijo.kill();
    await fin;
    assert.equal(almacen.contar(), 0);
    almacen.guardarTarea({ task_id: 'recuperada', original_prompt: 'prueba', created_at: '2026-01-01', complexity_level: 'low', recommended_model: 'test', complexity_score: 0, requires_human_review: false, subtasks: [] }, 'classified');
    almacen.cerrar();
    const verificacion = spawnSync(python, ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("SELECT task_id FROM tasks").fetchall())', ruta], { cwd: raiz, encoding: 'utf8' });
    assert.equal(verificacion.status, 0, verificacion.stderr);
    assert.match(verificacion.stdout, /recuperada/);
    assert.doesNotMatch(verificacion.stdout, /python/);
  } finally {
    if (hijo.exitCode === null && hijo.signalCode === null) { hijo.kill(); await fin; }
    almacen.cerrar();
    rmSync(dir, { recursive: true, force: true });
  }
});
