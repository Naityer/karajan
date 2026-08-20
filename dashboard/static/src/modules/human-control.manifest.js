import { ModuleManifest } from "../core/module.js";

export const MANIFEST = new ModuleManifest({
  id: "karajan.human-control",
  title: "Control humano",
  icon: "UserCheck",
  capabilities: ["tasks.read", "tasks.write"],
  views: [{ id: "human-control", dataView: "human", label: "Control humano" }],
  publishes: ["karajan.task.selected"],
  consumes: ["karajan.task.changed"],
});
