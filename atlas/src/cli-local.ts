import type { Almacen } from './almacen';
import { calcularProduccion } from './produccion';
import { catalogoReal } from './catalogo';
import { disponibilidad, PROVEEDORES } from './proveedores';
import { validarLayout } from './perfiles';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Biblioteca } from './biblioteca';

export function abrirBibliotecaLocal(archivo: string): Biblioteca {
  if (!existsSync(archivo)) throw new Error('el archivo no existe');
  const comprobacion = new DatabaseSync(archivo, { readOnly: true });
  try {
    const tablas = new Set((comprobacion.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((x) => x.name));
    for (const nombre of ['resources', 'resource_groups', 'resource_group_assignments', 'resource_operations', 'resource_preferences', 'discovery_sources'])
      if (!tablas.has(nombre)) throw new Error(`falta la tabla ${nombre}`);
  } finally { comprobacion.close(); }
  return new Biblioteca(archivo, { estricto: true });
}

/** Misma detección que la API, sin lanzar una tarea de agente. */
export const proveedoresLocales = () => PROVEEDORES.map((p) => disponibilidad(p));

/** Prepara la analítica local con los mismos componentes que el adaptador HTTP. */
export function produccionLocal(almacen: Almacen, q: Record<string, string | undefined>, leer: ((ruta: string) => string) | undefined, fichero: string | null | undefined) {
  let perfil: ReturnType<typeof validarLayout> | null = null;
  if (q['perfil'] !== 'todos') {
    if (!fichero || !leer) throw new Error('perfil activo necesita --layout o KARAJAN_ROUTING_LAYOUT');
    perfil = validarLayout(JSON.parse(leer(fichero)));
  }
  return calcularProduccion(almacen.tareasPlanas(), q, {
    catalogo: catalogoReal,
    perfil: () => perfil?.profiles.find((x) => x.id === perfil!.default_profile_id) ?? null,
    disponibles: () => new Map(PROVEEDORES.map((x) => [x.nombre, disponibilidad(x).disponible] as const)),
    ahora: () => new Date(),
  });
}
