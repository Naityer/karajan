import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Almacen } from './almacen';
import { Rotador } from './rotador';
import { Delegador } from './delegar';
import { configDesde } from './heuristica';
import { Perfiles } from './perfiles';
import { AtlasDev } from './atlas-dev';
import { Pasarela } from './pasarela-borradores';
import { inventarioConCache } from './especialistas';
import { ConfiguracionEspecialistas } from './especialistas-config';
import { descubrirSkills } from './skills-seleccion';
import { Guardian, type PeticionMutacion } from './modo';
import { Biblioteca } from './biblioteca';
import { RegistroLab } from './laboratorio';

/** Construye las dependencias del paquete; no registra rutas ni abre un puerto. */
export function crearRuntime(datos: string) {
  const explicita = process.env['ATLAS_KARAJAN_DATA'] || undefined;
  const ws = process.env['ATLAS_WORKSPACE'];
  if (explicita && !existsSync(explicita)) throw new Error(`ATLAS_KARAJAN_DATA no existe: ${explicita}`);
  const nativo = explicita ?? (ws && existsSync(join(ws, 'karajan', 'data', 'task_logs.db')) ? join(ws, 'karajan', 'data') : null);
  if (explicita && !existsSync(join(explicita, 'task_logs.db'))) throw new Error(`No existe task_logs.db en ATLAS_KARAJAN_DATA: ${explicita}`);
  const compartida = nativo !== null && process.env['ATLAS_KARAJAN_COMPARTIR'] !== '0' && existsSync(join(nativo, 'task_logs.db'));
  let importada = false;
  const bloqueoImportacion = join(datos, '.task-import-lock');
  if (!compartida && existsSync(bloqueoImportacion)) throw new Error(`Importación en curso o interrumpida: ${bloqueoImportacion}. Comprueba que no haya otra importación antes de retirar el bloqueo.`);
  if (!compartida && explicita && !existsSync(join(datos, 'task_logs.db')) && existsSync(join(explicita, 'task_logs.db'))) {
    mkdirSync(datos, { recursive: true });
    // VACUUM INTO genera una instantánea coherente incluso con WAL activo;
    // copiar el fichero principal y sus sidecars por separado no es atómico.
    const temporal = join(datos, `.task-logs-snapshot-${randomUUID()}.db`);
    let publicada = false, completa = false;
    try { mkdirSync(bloqueoImportacion); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Otra importación utiliza ${bloqueoImportacion}; espera a que termine.`);
      throw err;
    }
    try {
      if (existsSync(join(datos, 'task_logs.db'))) throw new Error('La base de destino apareció durante la importación');
      const origen = new DatabaseSync(join(explicita, 'task_logs.db'), { readOnly: true });
      try { origen.prepare('VACUUM INTO ?').run(temporal); } finally { origen.close(); }
      if (existsSync(join(datos, 'task_logs.db'))) throw new Error('La base de destino apareció durante la importación');
      renameSync(temporal, join(datos, 'task_logs.db'));
      publicada = true;
      if (existsSync(join(explicita, 'active_config.json')) && !existsSync(join(datos, 'active_config.json'))) copyFileSync(join(explicita, 'active_config.json'), join(datos, 'active_config.json'));
      completa = true;
    } finally {
      if (existsSync(temporal)) unlinkSync(temporal);
      // Si falla después de publicar la base, conservar el bloqueo impide
      // arrancar con una configuración posiblemente incompleta.
      if (!publicada || completa) rmdirSync(bloqueoImportacion);
    }
    importada = true;
  }
  if (!compartida && existsSync(bloqueoImportacion)) throw new Error(`Importación en curso o interrumpida: ${bloqueoImportacion}. Comprueba que no haya otra importación antes de retirar el bloqueo.`);
  mkdirSync(datos, { recursive: true });
  const dirDatos = compartida ? nativo! : datos;
  if (!existsSync(join(dirDatos, 'modo.json'))) writeFileSync(join(dirDatos, 'modo.json'), '{"modo":"produccion"}\n', 'utf8');
  const almacen = new Almacen(join(dirDatos, 'task_logs.db'));
  const config = () => { try { return configDesde(JSON.parse(readFileSync(join(dirDatos, 'active_config.json'), 'utf8'))); } catch { return configDesde(null); } };
  const rutaLayout = process.env['ATLAS_KARAJAN_LAYOUT'] ?? (nativo ? join(nativo, 'routing_layout.json') : join(datos, 'routing_layout.json'));
  const perfiles = new Perfiles(rutaLayout);
  const usosKarajan = () => {
    const r: Record<string, string> = {};
    for (const t of almacen.tareasPlanas()) for (const s of t.ejecutadas ?? []) if (!r[s] || t.created_at > r[s]!) r[s] = t.created_at;
    return r;
  };
  const historiaKarajan = () => almacen.tareasPlanas().flatMap((t) => (t.ejecutadas ?? []).map((skill) => ({ skill, cuando: t.created_at })));
  const rotador = new Rotador({ estado: join(datos, 'rotador.json'), usosKarajan, historiaKarajan });
  const especialistas = new ConfiguracionEspecialistas(join(dirDatos, 'especialistas.json'));
  const inventario = inventarioConCache(() => descubrirSkills());
  const delegador = new Delegador({ almacen, perfiles, config, raiz: ws ?? homedir(), rotador, skillsDisponibles: inventario.leer, especialistas: () => especialistas.leer() });
  const dirLab = join(datos, 'laboratorio');
  const atlasDev = new AtlasDev();
  const pasarela = new Pasarela(atlasDev, join(dirLab, 'borradores.json'));
  const guardian = new Guardian(dirDatos, atlasDev, pasarela);
  const mutar = async <T>(peticion: PeticionMutacion, accion: string, operacion: () => T | Promise<T>): Promise<T> => {
    await guardian.exigir(peticion, accion);
    return operacion();
  };
  const rutaBiblioteca = process.env['ATLAS_KARAJAN_RESOURCES'] ?? join(nativo ?? datos, 'resources.db');
  let biblioteca: Biblioteca;
  let registroLab: RegistroLab;
  try {
    biblioteca = new Biblioteca(rutaBiblioteca);
    try { registroLab = new RegistroLab(join(dirLab, 'laboratorio.db')); }
    catch (err) { biblioteca.cerrar(); throw err; }
  } catch (err) {
    almacen.cerrar();
    throw err;
  }
  return { nativo, compartida, importada, dirDatos, almacen, config, rutaLayout, perfiles, rotador, especialistas, inventario, delegador, dirLab, atlasDev, pasarela, guardian, mutar, rutaBiblioteca, biblioteca, registroLab,
    cerrar: () => { registroLab.cerrar(); biblioteca.cerrar(); almacen.cerrar(); } };
}
