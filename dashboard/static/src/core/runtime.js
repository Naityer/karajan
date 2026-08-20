// ---- contexto de runtime ---------------------------------------------------
// Nota "Plan de mejora", §3: hoy app.js conoce demasiado su entorno — decide
// dónde está la API mirando `window.location.pathname` y usa `fetch`,
// `EventSource`, `localStorage`, `window`, `document`, `postMessage`
// directamente desde el código de las vistas. Eso es justo lo que impide
// convertirlo en módulos: una vista no debería tener que saber si está en
// Atlas, en localhost o en karajan.ai.
//
// `KarajanRuntimeContext` es el objeto que sí lo sabe, y que cada vista recibe
// en vez de tocar el entorno por su cuenta. `createRuntimeContext()` monta uno
// en modo standalone (el comportamiento actual); `src/distributions/atlas/`
// y `src/distributions/saas/` construyen el mismo contrato con otros
// proveedores por debajo (ver `src/distributions/README.md`).

import { ApiClient } from "./api-client.js";
import { LocalEventBus } from "./event-bus.js";
import { KarajanStore } from "./store.js";
import { KarajanRegistry } from "./registry.js";

/**
 * @typedef {Object} StorageProvider
 * @property {(key: string) => string|null} get
 * @property {(key: string, value: string) => void} set
 * @property {(key: string) => void} remove
 */

/** `localStorage` tal cual, tras la interfaz `StorageProvider`. Es el
 * proveedor de standalone; Atlas embebido sustituye esto por el relay de
 * `atlas-relay.js` (que ya hoy parchea `localStorage` para el iframe
 * sandboxed) expuesto con esta misma forma. */
export function localStorageProvider(storageImpl = window.localStorage) {
  return {
    get: (key) => storageImpl.getItem(key),
    set: (key, value) => storageImpl.setItem(key, value),
    remove: (key) => storageImpl.removeItem(key),
  };
}

/**
 * @typedef {Object} KarajanRuntimeContext
 * @property {"standalone"|"addon"|"saas"} mode
 * @property {ApiClient} api
 * @property {StorageProvider} storage
 * @property {LocalEventBus} events
 * @property {KarajanStore} store
 * @property {KarajanRegistry} registry
 * @property {object} auth
 * @property {object} workspace
 * @property {object} theme
 * @property {object} notifications
 * @property {object} navigation
 * @property {object} capabilities
 */

/**
 * Construye el contexto de runtime en modo standalone: API local, storage del
 * navegador, bus de eventos en memoria. Es el modo por defecto — Atlas y SaaS
 * llaman a esto y sustituyen solo las piezas que necesitan cambiar (ver
 * `src/distributions/`), en vez de reimplementar el contrato entero.
 *
 * @returns {KarajanRuntimeContext}
 */
export function createRuntimeContext({ mode = "standalone", overrides = {} } = {}) {
  const events = overrides.events ?? new LocalEventBus();
  const api = overrides.api ?? new ApiClient();
  const storage = overrides.storage ?? localStorageProvider();
  const store = overrides.store ?? new KarajanStore(events);
  const registry = overrides.registry ?? new KarajanRegistry();

  return {
    mode,
    api,
    storage,
    events,
    store,
    registry,
    auth: overrides.auth ?? { identity: "local" },
    workspace: overrides.workspace ?? { tenant: "local", workspace: "default", project: "default" },
    theme: overrides.theme ?? { mode: "dark" },
    notifications: overrides.notifications ?? null,
    navigation: overrides.navigation ?? null,
    capabilities: overrides.capabilities ?? new Set(),
  };
}
