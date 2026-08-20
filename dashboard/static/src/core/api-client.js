// ---- cliente API -------------------------------------------------------
// Extraído de app.js (nota "Plan de mejora", §3/§19): antes cada vista tocaba
// `fetch` directamente y resolvía `API_BASE` por su cuenta. Ahora es la única
// pieza que sabe dónde vive el backend — el resto del dashboard pide datos a
// través de un `ApiClient`, nunca a `fetch` en crudo.
//
// El dashboard corre en dos sitios y el MISMO archivo debe valer:
//   1. Suelto           → lo sirve su propio FastAPI en la raíz.
//   2. Empaquetado como → un host (Atlas) lo sirve bajo `/…/addons/<id>/app/` y
//      add-on de Atlas     expone su backend en `/…/addons/<id>/api`.
// Derivarla de `location` evita mantener dos copias y atar el paquete a una ruta.
export function resolveApiBase(pathname = window.location.pathname) {
  const mounted = /^(.*\/addons\/[^/]+)\/app(\/|$)/.exec(pathname);
  return mounted ? `${mounted[1]}/api` : "";
}

/**
 * Cliente HTTP del backend de Karajan. `base` se resuelve una vez (en modo
 * standalone es "", embebido en Atlas es la ruta del add-on) y cada método
 * antepone esa base a rutas absolutas del backend (`/tasks` → `…/api/tasks`).
 */
export class ApiClient {
  constructor({ base = resolveApiBase(), fetchImpl = window.fetch.bind(window) } = {}) {
    this.base = base;
    this._fetch = fetchImpl;
  }

  url(path) {
    return `${this.base}${path}`;
  }

  async request(path, options = {}) {
    const res = await this._fetch(this.url(path), {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.detail || `HTTP ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return res.status === 204 ? null : res.json();
  }

  get(path, options) {
    return this.request(path, { ...options, method: "GET" });
  }

  post(path, body, options) {
    return this.request(path, { ...options, method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  }

  put(path, body, options) {
    return this.request(path, { ...options, method: "PUT", body: body === undefined ? undefined : JSON.stringify(body) });
  }

  patch(path, body, options) {
    return this.request(path, { ...options, method: "PATCH", body: body === undefined ? undefined : JSON.stringify(body) });
  }

  delete(path, options) {
    return this.request(path, { ...options, method: "DELETE" });
  }

  /** Un `EventSource` apuntando a esta misma base (para `/events`). */
  eventSource(path, eventSourceImpl = window.EventSource) {
    return new eventSourceImpl(this.url(path));
  }
}
