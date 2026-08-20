// ---- distribución SaaS ------------------------------------------------------
// Nota "Plan de mejora", §4, §14: mismo contrato `KarajanRuntimeContext`, con
// el bus de eventos sobre SSE/WebSocket real en vez de en memoria —
// necesario en cuanto hay más de un cliente mirando el mismo workspace.
//
// `SseEventBus` envuelve el mismo `EventSource` que ya usa
// `initLiveEvents()` (`src/modules/shell.js`) tras la interfaz `LocalEventBus`
// (`on`/`off`/`emit`), para que un módulo escrito contra `events.on(topic, cb)`
// no note la diferencia entre standalone (bus en memoria) y SaaS (SSE
// multi-cliente). La migración de `initLiveEvents()` para *usar* este bus en
// vez de su dispatcher manual es trabajo posterior — ver la misma nota en
// `distributions/atlas.js`.
import { LocalEventBus } from "../core/event-bus.js";
import { createRuntimeContext } from "../core/runtime.js";

export class SseEventBus extends LocalEventBus {
  constructor(api, path = "/events") {
    super();
    this._source = api.eventSource(path);
    this._source.onmessage = (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      // El backend publica `{type, ...datos}` (ver `app/events.py`); `type`
      // hace de topic para que los suscriptores no tengan que parsear el sobre.
      super.emit(payload.type, payload);
    };
  }

  close() {
    this._source.close();
  }
}

export function createSaasContext(overrides = {}) {
  const ctx = createRuntimeContext({ mode: "saas", overrides });
  if (!overrides.events) ctx.events = new SseEventBus(ctx.api);
  return ctx;
}
