import { ModuleManifest } from "../core/module.js";

export const MANIFEST = new ModuleManifest({
  id: "karajan.inspiration",
  title: "Inspiration",
  icon: "Sparkles",
  capabilities: ["resources.read", "resources.write"],
  views: [{ id: "inspiration", dataView: "resources", label: "Inspiration" }],
  publishes: ["karajan.resource.changed"],
});
