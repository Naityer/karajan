// ---- registro de objetos UI ------------------------------------------------
// Nota "Plan de mejora", §6-§11 y §23-§25: Atlas (o cualquier host) no debe
// "controlar la página de Karajan" — debe poder preguntar por un objeto por
// id y montarlo donde quiera, sin conocer su DOM interno.
//
// `KarajanUIObject` es el contrato mínimo que cualquier vista o widget
// registrado debe cumplir. `KarajanRegistry` es el catálogo consultable:
// vistas completas (las 6 del producto) y widgets sueltos (p.ej. sacar solo
// `karajan.task-trace` de dentro de Estadísticas) conviven con la misma
// interfaz — ver `src/objects/` para las implementaciones.

/**
 * @typedef {Object} KarajanUIObject
 * @property {string} id
 * @property {"view"|"panel"|"widget"|"action"} type
 * @property {(container: HTMLElement, context: import("./runtime.js").KarajanRuntimeContext) => void} mount
 * @property {() => void} [activate]
 * @property {() => void} [deactivate]
 * @property {(context: import("./runtime.js").KarajanRuntimeContext) => void} [update]
 * @property {() => void} destroy
 * @property {(hostContext: object) => boolean} [canMount]
 */

export class KarajanRegistry {
  constructor() {
    this._objects = new Map(); // id -> { descriptor, factory }
    this._commands = new Map(); // id -> handler
  }

  /**
   * Registra un objeto UI. `factory` construye una instancia nueva
   * (`KarajanUIObject`) cada vez que se monta — dos hosts pidiendo el mismo
   * id no deben compartir estado DOM.
   *
   * @param {{id: string, type: string, module: string, capabilities?: string[]}} descriptor
   * @param {() => KarajanUIObject} factory
   */
  register(descriptor, factory) {
    if (this._objects.has(descriptor.id)) {
      throw new Error(`karajan registry: "${descriptor.id}" ya está registrado`);
    }
    this._objects.set(descriptor.id, { descriptor, factory });
  }

  /** Metadatos de un objeto registrado (sin instanciarlo). */
  describe(id) {
    return this._objects.get(id)?.descriptor ?? null;
  }

  /** Lista los descriptores registrados, opcionalmente filtrados por módulo. */
  list({ module } = {}) {
    const all = [...this._objects.values()].map((entry) => entry.descriptor);
    return module ? all.filter((d) => d.module === module) : all;
  }

  /** Instancia un objeto UI listo para `mount(container, context)`. */
  create(id) {
    const entry = this._objects.get(id);
    if (!entry) throw new Error(`karajan registry: objeto desconocido "${id}"`);
    return entry.factory();
  }

  registerCommand(id, handler) {
    this._commands.set(id, handler);
  }

  runCommand(id, ...args) {
    const handler = this._commands.get(id);
    if (!handler) throw new Error(`karajan registry: comando desconocido "${id}"`);
    return handler(...args);
  }

  listCommands() {
    return [...this._commands.keys()];
  }
}
