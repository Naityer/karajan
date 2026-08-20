// ---- bus de eventos ------------------------------------------------------
// Nota "Plan de mejora", §20: vocabulario de eventos de dominio/UI que un
// módulo publica y otro consume, sin que ninguno de los dos conozca al otro.
// Reemplaza el acoplamiento implícito de hoy, donde un módulo llama
// directamente a la función de render de otro (p.ej. Decisión sabe que debe
// refrescar el panel de Agentes tras un cambio de enrutado).
//
// `LocalEventBus` es la implementación in-process que usa standalone. Atlas y
// SaaS aportan la suya (SSE/WebSocket, postMessage) con la misma interfaz —
// ver `src/distributions/*` — así que ningún módulo necesita saber cuál está
// activa.
export class LocalEventBus {
  constructor() {
    this._listeners = new Map(); // topic -> Set<handler>
  }

  on(topic, handler) {
    if (!this._listeners.has(topic)) this._listeners.set(topic, new Set());
    this._listeners.get(topic).add(handler);
    return () => this.off(topic, handler);
  }

  off(topic, handler) {
    this._listeners.get(topic)?.delete(handler);
  }

  emit(topic, payload) {
    for (const handler of this._listeners.get(topic) ?? []) {
      try {
        handler(payload, topic);
      } catch (error) {
        console.error(`[event-bus] handler for "${topic}" threw`, error);
      }
    }
  }
}

// Vocabulario de eventos de dominio (nota §20). Los módulos importan estos
// nombres en vez de escribir el string a mano, para que un typo no cree un
// canal silenciosamente muerto.
export const TOPICS = Object.freeze({
  TASK_SELECTED: "karajan.task.selected",
  TASK_CHANGED: "karajan.task.changed",
  AGENT_SELECTED: "karajan.agent.selected",
  AGENT_CHANGED: "karajan.agent.changed",
  ROUTING_CHANGED: "karajan.routing.changed",
  RESOURCE_SELECTED: "karajan.resource.selected",
  RESOURCE_CHANGED: "karajan.resource.changed",
  SKILL_CHANGED: "karajan.skill.changed",
  DECISION_REQUIRED: "karajan.decision.required",
  DECISION_RESOLVED: "karajan.decision.resolved",
  CONFIG_CHANGED: "karajan.config.changed",
});
