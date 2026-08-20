import { ModuleManifest } from "../core/module.js";

export const MANIFEST = new ModuleManifest({
  id: "karajan.monitoring",
  title: "Estadísticas",
  icon: "Activity",
  capabilities: ["tasks.read"],
  views: [{ id: "monitoring", dataView: "monitor", label: "Estadísticas" }],
  objects: [
    {
      id: "karajan.agent-performance",
      type: "widget",
      title: "Rendimiento por agente",
      description: "Tabla de coste, latencia y errores por agente, agregada sobre GET /agents/performance.",
      capabilities: ["tasks.read"],
    },
    {
      id: "karajan.task-metrics",
      type: "widget",
      title: "Métricas de tareas",
      description: "KPIs de volumen, complejidad y coste agregados, sobre GET /metrics.",
      capabilities: ["tasks.read"],
    },
  ],
  consumes: ["karajan.task.changed"],
});
