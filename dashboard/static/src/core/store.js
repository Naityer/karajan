// ---- store por slices ----------------------------------------------------
// Nota "Plan de mejora", §19: el `const state = {...}` global de app.js hoy
// es compartido por prácticamente todo, lo que hace imposible tener módulos
// realmente independientes — cualquiera puede leer o mutar el estado de
// cualquier otro.
//
// `KarajanStore` reemplaza eso por slices con dueño: cada módulo declara el
// suyo (`store.slice("decision")`) y solo lee `shared` explícitamente. No hay
// enforcement en tiempo de ejecución todavía (la migración de app.js es
// incremental — ver `docs/apps/karajan/logica-motores-empaquetados.md`), pero
// la forma ya obliga a nombrar qué se comparte en vez de heredar acceso total
// por estar en el mismo fichero.
export class KarajanStore {
  constructor(bus) {
    this._bus = bus;
    this._slices = new Map();
    this._slices.set("session", {});
    this._slices.set("shared", {});
  }

  /** Slice con nombre, creado perezosamente. Un módulo solo debería llamar
   * a esto con su propio nombre o con "shared"/"session". */
  slice(name) {
    if (!this._slices.has(name)) this._slices.set(name, {});
    return this._slices.get(name);
  }

  /** Sustituye (merge superficial) un slice y, si hay bus, emite un evento
   * `store.<slice>.changed` para quien quiera reaccionar sin sondear. */
  update(name, patch) {
    const current = this.slice(name);
    const next = { ...current, ...patch };
    this._slices.set(name, next);
    this._bus?.emit(`store.${name}.changed`, next);
    return next;
  }
}
