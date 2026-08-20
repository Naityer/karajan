// ---- registro de módulos y vistas ------------------------------------------
// Nota "Plan de mejora", §6-§11: un host (Atlas u otro) debe poder preguntar
// "¿qué módulos/vistas tiene Karajan?" y montarlos, sin tener que abrir la
// aplicación completa ni conocer su DOM.
//
// Cada vista aquí es todavía una "vista completa" (una de las 6 pestañas),
// montada reutilizando el mecanismo de pestañas existente — no un widget
// aislado. Es la pieza que la nota llama `LegacyAtlasFrameAdapter`-friendly:
// permite consultar y activar programáticamente sin exigir que las vistas ya
// estén descompuestas en objetos UI de grano fino (ese catálogo — TaskTrace,
// AgentPerformance, ArchitectureGraph...— es trabajo posterior, sección 8 de
// la nota, que requiere convertir cada render() en algo montable dentro de un
// `container` cualquiera en vez de la página entera).
import { KarajanRegistry } from "./core/registry.js";
import { MANIFEST as humanControlManifest } from "./modules/human-control.manifest.js";
import { MANIFEST as monitorManifest } from "./modules/monitor.manifest.js";
import { MANIFEST as decisionManifest } from "./modules/decision.manifest.js";
import { MANIFEST as flowManifest } from "./modules/flow.manifest.js";
import { MANIFEST as inspirationManifest } from "./modules/inspiration.manifest.js";
import { createAgentPerformanceObject } from "./objects/agent-performance.js";
import { createTaskMetricsObject } from "./objects/task-metrics.js";

const MODULE_MANIFESTS = [humanControlManifest, monitorManifest, decisionManifest, flowManifest, inspirationManifest];

export const registry = new KarajanRegistry();

// Objetos UI de grano fino (nota "Plan de mejora", §8): a diferencia de los
// `legacyViewObject` de abajo, estos SÍ montan en el `container` que reciben
// — es el catálogo que un host puede pedir suelto (p.ej. `addon-object-host.tsx`
// en Atlas), no una pestaña completa. Crece módulo a módulo según cada
// `render()` se vaya convirtiendo a aceptar un contenedor (ver el comentario
// de `renderKpis`/`renderAgentPerformancePanel` en modules/monitor.js).
const FINE_GRAINED_OBJECTS = [
  { module: "karajan.monitoring", capabilities: ["tasks.read"], factory: createAgentPerformanceObject },
  { module: "karajan.monitoring", capabilities: ["tasks.read"], factory: createTaskMetricsObject },
];

for (const entry of FINE_GRAINED_OBJECTS) {
  const probe = entry.factory();
  registry.register(
    { id: probe.id, type: probe.type, module: entry.module, capabilities: entry.capabilities },
    entry.factory
  );
}

/** Objeto UI "vista completa": activa la pestaña legacy correspondiente
 * dentro del `document` real. `container` se ignora a propósito — todavía no
 * hay forma de renderizar una vista fuera de la página completa; documentarlo
 * aquí en vez de fingir que ya soporta contenedores arbitrarios. */
function legacyViewObject(view, moduleId) {
  return {
    id: `karajan.${view.id}`,
    type: "view",
    module: moduleId,
    mount() {
      document.querySelector(`.view-tab[data-view="${view.dataView}"]`)?.click();
    },
    destroy() {},
    canMount() {
      return document.querySelector(`.view-tab[data-view="${view.dataView}"]`) != null;
    },
  };
}

// dataView (el `data-view` de la pestaña legacy, lo que manda Atlas en
// `atlas:navigate`) -> id del objeto en el registry. Permite que un host que
// solo conoce el vocabulario antiguo de pestañas siga funcionando sin cambios
// mientras resuelve contra el registry por debajo (ver `atlas-host.js`).
const DATA_VIEW_TO_OBJECT_ID = new Map();

for (const manifest of MODULE_MANIFESTS) {
  for (const view of manifest.views) {
    const object = legacyViewObject(view, manifest.id);
    registry.register({ id: object.id, type: "view", module: manifest.id, capabilities: manifest.capabilities }, () => object);
    DATA_VIEW_TO_OBJECT_ID.set(view.dataView, object.id);
  }
}

/** El objeto UI (ya instanciado, listo para `.mount()`) para un `data-view`
 * legacy, o `null` si no hay ninguno registrado con ese nombre. */
export function objectForDataView(dataView) {
  const id = DATA_VIEW_TO_OBJECT_ID.get(dataView);
  return id ? registry.create(id) : null;
}

/** Instancia y monta un objeto del catálogo por id en `container`, o `false`
 * si el id no existe — lo usa `atlas-host.js` en modo `?atlas_object=`, el
 * hospedaje de UN objeto suelto (frame sandbox por objeto, nota §7/§12). */
export function mountObjectById(id, container) {
  if (!registry.describe(id)) return false;
  const object = registry.create(id);
  object.mount(container, { mode: "atlas-object" });
  return object;
}

/** Manifiesto agregado de Karajan (nota §24): lo que un host necesita leer
 * para saber qué módulos y vistas existen, sin ejecutar nada. */
export function buildManifest() {
  return {
    id: "karajan",
    modules: MODULE_MANIFESTS.map((m) => m.toJSON()),
    modes: ["standalone", "addon", "saas"],
  };
}

// Espacio de nombres propio (no toca `window.karajanCanvas`/`window.__isoTest`,
// que siguen siendo el contrato que ya consume `atlas-host.js`).
window.karajan = { registry, manifest: buildManifest() };
