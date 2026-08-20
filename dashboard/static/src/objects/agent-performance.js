// ---- objeto UI: karajan.agent-performance ----------------------------------
// Nota "Plan de mejora", §8/§23-§25: primer objeto de grano fino real — se
// monta en CUALQUIER `container`, no en la página entera (a diferencia de los
// `legacyViewObject` de `registry-bootstrap.js`). Reutiliza
// `renderAgentPerformancePanel` de `modules/monitor.js` tal cual: esa función
// ya era pura (recibe datos, devuelve HTML) y no escribía a un id fijo, así
// que no hizo falta reescribirla para hacerla montable.
import { api } from "../modules/shared.js";
import { renderAgentPerformancePanel } from "../modules/monitor.js";

const POLL_MS = 20000;

export function createAgentPerformanceObject() {
  let container = null;
  let timer = null;

  async function refresh() {
    if (!container) return;
    try {
      const perf = await api("/agents/performance");
      container.innerHTML = renderAgentPerformancePanel(perf);
    } catch (error) {
      container.innerHTML = `<div class="chart-empty">no se pudo cargar el rendimiento por agente: ${String(error.message || error)}</div>`;
    }
  }

  return {
    id: "karajan.agent-performance",
    type: "widget",
    module: "karajan.monitoring",
    mount(target) {
      container = target;
      container.classList.add("karajan-object", "karajan-object-agent-performance");
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
