import { ModuleManifest } from "../core/module.js";

export const MANIFEST = new ModuleManifest({
  id: "karajan.decision",
  title: "Decisión",
  icon: "Network",
  capabilities: ["routing.read", "routing.write", "agents.read", "skills.read"],
  views: [{ id: "decision", dataView: "decision", label: "Decisión" }],
  publishes: ["karajan.routing.changed"],
  consumes: ["karajan.config.changed"],
});
