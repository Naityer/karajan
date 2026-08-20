// ---- objeto UI: karajan.task-metrics ---------------------------------------
// Nota "Plan de mejora", §8/§23-§25. Reutiliza `renderKpis` de
// `modules/monitor.js`, generalizada para aceptar un `container` en vez de
// escribir siempre a `#kpis` (ver el comentario en su definición).
import { api } from "../modules/shared.js";
import { renderKpis } from "../modules/monitor.js";

const POLL_MS = 20000;

export function createTaskMetricsObject() {
  let container = null;
  let timer = null;

  async function refresh() {
    if (!container) return;
    try {
      const metrics = await api("/metrics");
      renderKpis(metrics, container);
    } catch (error) {
      container.innerHTML = `<div class="chart-empty">no se pudieron cargar las métricas: ${String(error.message || error)}</div>`;
    }
  }

  return {
    id: "karajan.task-metrics",
    type: "widget",
    module: "karajan.monitoring",
    mount(target) {
      container = target;
      container.classList.add("karajan-object", "karajan-object-task-metrics");
      refresh();
      timer = setInterval(refresh, POLL_MS);
    },
    update() {
      refresh();
    },
    destroy() {
      if (timer) clearInterval(timer);
      timer = null;
      container = null;
    },
    canMount() {
      return true;
    },
  };
}
