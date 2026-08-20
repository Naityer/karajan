import { ModuleManifest } from "../core/module.js";

// Un solo fichero fuente (`flow.js`) todavía cubre dos pestañas del producto
// —"Agentes" y "Configuración"— porque así estaban entrelazadas en el app.js
// original (banner "FLOW / PARAMETERS"). Separarlas en dos módulos reales
// (nota "Plan de mejora", §18) es trabajo pendiente y deliberadamente fuera
// de esta primera extracción mecánica; el manifiesto declara las dos vistas
// para que un host pueda montarlas por separado incluso antes de esa partición.
export const MANIFEST = new ModuleManifest({
  id: "karajan.flow",
  title: "Agentes y Configuración",
  icon: "Settings",
  capabilities: ["config.read", "config.write", "agents.read", "agents.write"],
  views: [
    { id: "agents", dataView: "agents", label: "Agentes" },
    { id: "configuration", dataView: "flow", label: "Configuración" },
  ],
  publishes: ["karajan.config.changed"],
  consumes: ["karajan.routing.changed"],
});
