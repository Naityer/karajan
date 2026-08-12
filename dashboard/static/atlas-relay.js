// Relay de API/almacenamiento de Atlas — lado add-on. Se carga ANTES que
// `app.js` (ver `index.html`): a diferencia de `atlas-host.js` (chrome, tema,
// herramientas — todo diferible a `DOMContentLoaded`), esto tiene que estar
// instalado antes de que `app.js` ejecute una sola línea, porque su arranque
// síncrono ya lee `localStorage` y hace peticiones.
//
// Atlas sirve este dashboard sin `allow-same-origin` (ver la nota
// `atlascritical` de "Seguridad" y `packaged-addon-frame.tsx`): el documento
// tiene un origen opaco, así que:
//
//   - Un `fetch`/`EventSource` suyo a `/…/addons/<id>/api/*` no puede leer la
//     respuesta (el origen opaco no satisface CORS) ni, en general, sostener
//     la cookie de sesión — la única vía es que el padre, que sí conserva el
//     origen real y la cookie, haga la petición por cuenta de este documento.
//   - `localStorage`/`sessionStorage` lanzan al primer acceso: un origen
//     opaco no tiene un origen estable al que asociar el almacén del
//     navegador.
//
// Se parchea `fetch`/`EventSource`/`localStorage` aquí en vez de tocar
// `app.js`: son el único punto de paso de todas sus llamadas y evita
// divergir del dashboard original (ver la cabecera de `atlas-host.js`).
(function () {
  'use strict';

  var ATLAS_HOST_SOURCE = 'atlas-host';
  var ATLAS_ADDON_SOURCE = 'atlas-addon';
  var STORAGE_RELAY_PATH = '/__atlas_storage__';

  var embedded = window.parent !== window;
  var apiMountMatch = /^(.*\/addons\/[^/]+)\/app(\/|$)/.exec(window.location.pathname);
  var apiMount = apiMountMatch ? apiMountMatch[1] + '/api' : null;

  if (!apiMount || !embedded) return;

  var mountedAddonId = /\/addons\/([^/]+)\/api$/.exec(apiMount)[1];
  var pendingRequests = new Map();
  var pendingStreams = new Map();
  var nextId = 0;
  function correlationId() {
    nextId += 1;
    return 'r' + Date.now().toString(36) + nextId;
  }
  function relativePath(url) {
    var idx = url.indexOf(apiMount);
    return idx === 0 ? url.slice(apiMount.length) || '/' : url;
  }
  function headersToObject(headers) {
    if (!headers) return undefined;
    var out = {};
    new Headers(headers).forEach(function (value, key) { out[key] = value; });
    return out;
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || msg.source !== ATLAS_HOST_SOURCE || msg.addonId !== mountedAddonId) return;
    if (msg.type === 'atlas:api-response' || msg.type === 'atlas:api-error') {
      var pending = pendingRequests.get(msg.correlationId);
      if (!pending) return;
      pendingRequests.delete(msg.correlationId);
      if (msg.type === 'atlas:api-error') pending.reject(new TypeError(msg.message || 'Fallo de red.'));
      else pending.resolve(new Response(msg.body, { status: msg.status, statusText: msg.statusText, headers: msg.headers }));
    } else if (msg.type === 'atlas:api-stream-event') {
      var es = pendingStreams.get(msg.correlationId);
      if (es) es._dispatch(msg.event, msg.data);
    } else if (msg.type === 'atlas:api-stream-error') {
      var stream = pendingStreams.get(msg.correlationId);
      if (stream) stream._reconnect();
    }
  });

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf(apiMount) !== 0) return nativeFetch(input, init);
    var method = ((init && init.method) || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    var body = (init && init.body) || (typeof input === 'object' ? input.body : undefined);
    if (body !== undefined && typeof body !== 'string') {
      return Promise.reject(new TypeError('El relay de Atlas solo reenvía cuerpos de texto/JSON.'));
    }
    var id = correlationId();
    return new Promise(function (resolve, reject) {
      pendingRequests.set(id, { resolve: resolve, reject: reject });
      window.parent.postMessage({
        source: ATLAS_ADDON_SOURCE, type: 'atlas:api-request', addonId: mountedAddonId,
        correlationId: id, method: method, path: relativePath(url),
        headers: headersToObject((init && init.headers) || (typeof input === 'object' ? input.headers : undefined)),
        body: body,
      }, '*');
    });
  };

  // Sustituye a `EventSource` nativo para las URLs del proxy de datos. Solo
  // cubre lo que `app.js` usa realmente (GET, sin cabeceras propias, con
  // reconexión) — no es un polyfill general de la interfaz `EventSource`.
  // Clase de verdad (no `Func.call(this)` sobre `EventTarget`): `EventTarget`
  // es una clase nativa y rechaza invocarse sin `new` — con el patrón antiguo
  // esta línea lanzaba y abortaba TODO el script antes de llegar siquiera al
  // shim de `localStorage`, más abajo.
  class RelayEventSource extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this._closed = false;
      this._onmessage = null;
      this._open();
    }
    _open() {
      this._id = correlationId();
      pendingStreams.set(this._id, this);
      this.readyState = 1;
      window.parent.postMessage({
        source: ATLAS_ADDON_SOURCE, type: 'atlas:api-stream-open', addonId: mountedAddonId,
        correlationId: this._id, path: relativePath(this.url),
      }, '*');
    }
    _dispatch(eventName, data) {
      this.dispatchEvent(new MessageEvent(eventName || 'message', { data: data }));
    }
    _reconnect() {
      if (this._closed) return;
      pendingStreams.delete(this._id);
      this.readyState = 0;
      this.dispatchEvent(new Event('error'));
      // Mismo margen que el reintento por defecto de un `EventSource` nativo.
      var self = this;
      setTimeout(function () {
        if (!self._closed) self._open();
      }, 3000);
    }
    get onmessage() { return this._onmessage; }
    set onmessage(fn) {
      if (this._onmessage) this.removeEventListener('message', this._onmessage);
      this._onmessage = typeof fn === 'function' ? fn : null;
      if (this._onmessage) this.addEventListener('message', this._onmessage);
    }
    close() {
      if (this._closed) return;
      this._closed = true;
      this.readyState = 2;
      pendingStreams.delete(this._id);
      window.parent.postMessage({
        source: ATLAS_ADDON_SOURCE, type: 'atlas:api-stream-close', addonId: mountedAddonId, correlationId: this._id,
      }, '*');
    }
  }

  var NativeEventSource = window.EventSource;
  window.EventSource = function (url) {
    if (typeof url === 'string' && url.indexOf(apiMount) === 0) return new RelayEventSource(url);
    return new NativeEventSource(url);
  };

  // ── localStorage ─────────────────────────────────────────────────────────
  // Sembrado síncrono desde el snapshot que Atlas inyecta en el `<head>` del
  // documento (ver `addon-app.controller.ts::withStorageSnapshot`) — así la
  // primera lectura de `app.js`, que es síncrona, encuentra datos reales.
  // Cada escritura queda en memoria al instante (lectura-tras-escritura en el
  // mismo tick, como el `localStorage` real) y además se manda al padre para
  // que la persista — de "mejor esfuerzo": si Atlas no llega a guardarla, el
  // peor caso es perder esa preferencia entre sesiones, no un fallo visible.
  (function installStorageShim() {
    var data = Object.assign({}, window.__ATLAS_STORAGE__ || {});
    function persist(op) {
      window.fetch(apiMount + STORAGE_RELAY_PATH, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op),
      }).catch(function () {});
    }
    var relayStorage = {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
      setItem: function (key, value) {
        value = String(value);
        data[key] = value;
        persist({ op: 'set', key: key, value: value });
      },
      removeItem: function (key) {
        delete data[key];
        persist({ op: 'remove', key: key });
      },
      clear: function () {
        data = {};
        persist({ op: 'clear' });
      },
      key: function (index) { return Object.keys(data)[index] || null; },
    };
    Object.defineProperty(relayStorage, 'length', { get: function () { return Object.keys(data).length; } });
    Object.defineProperty(window, 'localStorage', { value: relayStorage, configurable: true });
  })();
})();
