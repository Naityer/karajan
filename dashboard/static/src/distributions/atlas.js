// ---- distribución add-on de Atlas ------------------------------------------
// Nota "Plan de mejora", §4-§5, §21: mismo contrato `KarajanRuntimeContext`
// que standalone, pero con la navegación/tema resueltos contra el host en vez
// del propio DOM/`localStorage`.
//
// El protocolo real (`atlas:navigate`, `atlas:context`, `atlas:action`,
// `atlas:toolbar`, `atlas:ready`) vive hoy en `atlas-host.js` — un IIFE que
// negocia con el `window.parent` directamente. Estos adaptadores exponen ese
// mismo protocolo tras el contrato `RuntimeContext` (`navigation`/`theme`/
// `events`), para que un módulo pueda pedir "cambia de vista" o "publica este
// evento" sin saber que hay un iframe y `postMessage` debajo — igual que
// `objectForDataView` (`registry-bootstrap.js`) ya hace con la navegación
// *entrante*. Journal de integración: `atlas-host.js` usa hoy
// `objectForDataView` directamente; migrar su lógica de tema/toolbar a estos
// adaptadores es el siguiente paso, no incluido en este cambio para no volver
// a tocar un fichero ya verificado en producción en la misma pasada.
import { LocalEventBus } from "../core/event-bus.js";
import { createRuntimeContext } from "../core/runtime.js";
import { objectForDataView } from "../registry-bootstrap.js";

const ATLAS_HOST_SOURCE = "atlas-host";
const ATLAS_ADDON_SOURCE = "atlas-addon";

function isEmbedded() {
  return window.parent !== window;
}

function postToHost(message) {
  if (isEmbedded()) window.parent.postMessage({ source: ATLAS_ADDON_SOURCE, ...message }, "*");
}

/**
 * `LocalEventBus` de siempre, pero cada `emit()` también sale hacia el host
 * como `atlas:event` — y un `atlas:event` que llega del host se reemite
 * localmente. Así un módulo que solo conoce `events.emit(topic, payload)`
 * participa del bus del host sin código propio de `postMessage`.
 */
export class AtlasEventBusAdapter extends LocalEventBus {
  constructor() {
    super();
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.source !== ATLAS_HOST_SOURCE || msg.type !== "atlas:event") return;
      super.emit(msg.topic, msg.payload);
    });
  }

  emit(topic, payload) {
    super.emit(topic, payload);
    postToHost({ type: "atlas:event", topic, payload });
  }
}

/** Cambiar de vista pasa por el registry (`objectForDataView`), igual que
 * cuando la orden viene de un `atlas:navigate` entrante — `open()` es la
 * misma operación, solo que iniciada desde dentro de Karajan en vez de desde
 * el host. */
export const AtlasNavigationProvider = {
  open(dataView) {
    objectForDataView(dataView)?.mount();
  },
};

export const AtlasThemeProvider = {
  apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
  },
};

export function createAtlasContext(overrides = {}) {
  return createRuntimeContext({
    mode: "addon",
    overrides: {
      events: new AtlasEventBusAdapter(),
      navigation: AtlasNavigationProvider,
      theme: AtlasThemeProvider,
      ...overrides,
    },
  });
}
